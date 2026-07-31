/**
 * The PDF page's state: one file, its analysis, the settings rail, and at most
 * one compress run at a time.
 *
 * Shaped like `batch/queue.svelte.ts` and `shell/tabs.svelte.ts` — a class with
 * `$state` fields plus a `create*` factory — so the view is a pure reader and
 * every transition is unit-testable in node with the two engine calls injected.
 *
 * ## Why analysis gates compression
 *
 * `compressPdf` hands a refused document (encrypted, signed, unreadable) back
 * byte-for-byte and reports *no* reason — from the outside that is
 * indistinguishable from "nothing was worth replacing", so a signed PDF would
 * render a cheerful `0% saved`. {@link PdfJob.compress} therefore refuses to run
 * unless {@link PdfJob.analyze} has already produced a document without a
 * refusal, which is exactly the `'ready'` / `'done'` phases.
 *
 * ## Errors
 *
 * Abort is the only error `compressPdf` propagates; every per-image decode or
 * encode failure comes back inside `result.images` as an `'error'` outcome. So
 * `phase === 'error'` means the run itself died (usually the file became
 * unreadable between mount and press), and an abort rewinds to `'ready'` rather
 * than presenting a failure the user caused on purpose.
 *
 * ## Why the page preview is lazy
 *
 * The before/after rasterises one page of each document on demand, in
 * {@link PdfJob.showPage}, and never during the run. Capturing pages while
 * compressing would be simpler to wire but the ceiling is a 150 MB document
 * with 400 images, and a single A4 pair is already ~20 MB of `ImageData` — the
 * user looks at one page at a time, so that is what is held.
 */

import {
  DEFAULT_PDF_SETTINGS,
  isAbortError,
  type PdfAnalysis,
  type PdfCompressResult,
  type PdfCompressSettings,
  type PdfRefusal,
} from '../contracts';

import { analyzePdf } from './analyze';
import { compressPdf } from './compress';
import {
  clampPageIndex,
  fitScale,
  openPdfRenderer,
  type PdfRenderer,
  type RenderedPage,
} from './render';

/* -------------------------------------------------------------------------- */
/* Phases                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Where the job is.
 *
 * `refused` and `error` are both dead ends, kept apart because they are
 * different sentences: `refused` is "this document must not be touched, and here
 * is why", `error` is "we tried and the machinery broke".
 */
export type PdfPhase = 'analyzing' | 'refused' | 'ready' | 'compressing' | 'done' | 'error';

/** The engine calls, injectable so tests need neither canvas nor worker. */
export interface PdfJobDeps {
  analyze?: typeof analyzePdf;
  compress?: typeof compressPdf;
  /** Opens a page rasteriser. Injected so tests need neither pdf.js nor a DOM. */
  openRenderer?: typeof openPdfRenderer;
}

/* -------------------------------------------------------------------------- */
/* Refusals                                                                    */
/* -------------------------------------------------------------------------- */

const REFUSAL_MESSAGE: Readonly<Record<PdfRefusal, string>> = {
  encrypted: 'This PDF is encrypted — remove the password first.',
  signed: 'This PDF is digitally signed — compressing would break the signature.',
  unreadable: 'This is not a PDF Pinch can read.',
};

/**
 * The sentence shown for a document we will not rewrite. Each one names the
 * cause and, where there is one, the way out — a refusal the user cannot act on
 * reads like a bug.
 */
export function pdfRefusalMessage(reason: PdfRefusal): string {
  return REFUSAL_MESSAGE[reason];
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One page rasterised from both documents.
 *
 * The two sides are called `original` and `output` because those are
 * `RevealCompare`'s prop names — the view hands them straight over.
 */
export interface PdfPreviewPage {
  /** Zero-based page these pixels came from. */
  readonly pageIndex: number;
  readonly original: RenderedPage;
  readonly output: RenderedPage;
}

/** Both documents, open at once so paging does not reparse either one. */
interface PdfRendererPair {
  readonly original: PdfRenderer;
  readonly output: PdfRenderer;
}

/**
 * Box a preview page is rasterised to fit, in CSS pixels.
 *
 * One raster serves every zoom level: `RevealCompare` pans and zooms with a CSS
 * transform, so re-rendering per zoom step would buy sharpness at the cost of a
 * worker round trip on every scroll. Sizing by a box rather than by a fixed
 * scale is what keeps an A0 poster from allocating a quarter of a gigabyte a
 * side — this is 10 MB whatever the page measures.
 */
const PREVIEW_BOX = { width: 1600, height: 1600 } as const;

/** Never magnify: a small page blown up adds bytes, not detail. */
const PREVIEW_MAX_SCALE = 2;

/**
 * Rendered pairs kept in memory.
 *
 * Two — the page on screen plus the one just left, so stepping back and forth
 * across a boundary is free. A third would cost another ~20 MB for a page
 * nobody is looking at.
 */
export const PDF_PREVIEW_CACHE_LIMIT = 2;

/**
 * Put `entry` at the head of the LRU and drop anything past `limit`.
 *
 * Pure and exported so eviction is testable without pdf.js, a canvas or a DOM.
 * A cache *hit* re-inserts the entry it found, which is what makes this the
 * "recently used" half as well as the "insert" half.
 */
export function cachePreviewPages<T extends { readonly pageIndex: number }>(
  cache: readonly T[],
  entry: T,
  limit: number = PDF_PREVIEW_CACHE_LIMIT,
): T[] {
  if (limit <= 0) return [];
  return [entry, ...cache.filter((page) => page.pageIndex !== entry.pageIndex)].slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* Job                                                                         */
/* -------------------------------------------------------------------------- */

export class PdfJob {
  readonly file: File;

  phase = $state<PdfPhase>('analyzing');
  analysis = $state<PdfAnalysis | undefined>(undefined);
  /**
   * The settings rail. Replace it wholesale (`job.settings = { ...job.settings,
   * targetDpi: 96 }`) — the contract's fields are `readonly` on purpose, so the
   * snapshot a run receives can never be edited underneath it.
   */
  settings = $state<PdfCompressSettings>({ ...DEFAULT_PDF_SETTINGS });
  progress = $state({ done: 0, total: 0 });
  result = $state<PdfCompressResult | undefined>(undefined);
  /** Refusal sentence in `'refused'`, failure message in `'error'`. */
  error = $state<string | undefined>(undefined);

  /** Zero-based page the before/after is showing. Move it with {@link showPage}. */
  previewPage = $state(0);
  /** Pixels for {@link previewPage}, once both sides have rasterised. */
  preview = $state<PdfPreviewPage | undefined>(undefined);
  /** A pair is being rendered. Never true for a cache hit — that is synchronous. */
  previewLoading = $state(false);
  /** Why the last render failed. Cleared the moment another page is asked for. */
  previewError = $state<string | undefined>(undefined);

  readonly #analyze: typeof analyzePdf;
  readonly #compress: typeof compressPdf;
  readonly #openRenderer: typeof openPdfRenderer;
  #controller: AbortController | undefined;
  #previewController: AbortController | undefined;
  /** Not `$state`: the view reads {@link preview}, never the cache behind it. */
  #cache: PdfPreviewPage[] = [];
  #renderers: Promise<PdfRendererPair> | undefined;

  constructor(file: File, deps: PdfJobDeps = {}) {
    this.file = file;
    this.#analyze = deps.analyze ?? analyzePdf;
    this.#compress = deps.compress ?? compressPdf;
    this.#openRenderer = deps.openRenderer ?? openPdfRenderer;
  }

  /** True while a run is in flight — the view's Compress/Stop switch. */
  get running(): boolean {
    return this.phase === 'compressing';
  }

  /**
   * Can {@link compress} do anything right now?
   *
   * `'error'` is in here so a run that died mid-flight is retryable: the
   * analysis it was launched from is still valid, so there is nothing to redo
   * before pressing Compress again. Only a missing or refused analysis is a
   * genuine dead end — that is what the blocked screen is for.
   */
  get canCompress(): boolean {
    if (this.phase !== 'ready' && this.phase !== 'done' && this.phase !== 'error') return false;
    return this.analysis !== undefined && this.analysis.refusal === undefined;
  }

  /** Pages the preview can move between. `0` until the analysis lands. */
  get pageCount(): number {
    return this.analysis?.pageCount ?? 0;
  }

  /** Is there anything to compare? A before/after needs both documents. */
  get canPreview(): boolean {
    return this.result !== undefined && this.pageCount > 0;
  }

  /**
   * Read the document without changing a byte. Called once on mount; safe to
   * call again (the "choose another file" path mounts a fresh job instead).
   */
  async analyze(): Promise<void> {
    this.phase = 'analyzing';
    this.analysis = undefined;
    this.result = undefined;
    this.error = undefined;
    this.progress = { done: 0, total: 0 };
    this.previewPage = 0;
    this.#resetPreview();

    try {
      const bytes = await this.file.arrayBuffer();
      const analysis = await this.#analyze(bytes);
      this.analysis = analysis;

      if (analysis.refusal) {
        this.error = pdfRefusalMessage(analysis.refusal);
        this.phase = 'refused';
        return;
      }
      this.phase = 'ready';
    } catch (error) {
      // `analyzePdf` never throws; `file.arrayBuffer()` does when the file moved
      // out from under the picker.
      this.error = messageOf(error);
      this.phase = 'error';
    }
  }

  /**
   * Recompress the document with the current settings.
   *
   * A no-op unless {@link canCompress} — the analysis cleared the document
   * (`'ready'`), a previous run finished (`'done'`, so the rail can be re-tuned
   * and re-run), or a previous run failed (`'error'`, retryable against the same
   * analysis). Never concurrent: `'compressing'` falls through the same guard.
   */
  async compress(): Promise<void> {
    if (!this.canCompress) return;
    const analysis = this.analysis;
    // Belt and braces: `canCompress` already implies a clean analysis, and a run
    // without one cannot tell "refused" from "nothing to do".
    if (!analysis || analysis.refusal) return;

    const controller = new AbortController();
    this.#controller = controller;
    this.phase = 'compressing';
    this.result = undefined;
    this.error = undefined;
    this.progress = { done: 0, total: analysis.images.length };
    // Every rendered page belonged to the output this run is about to replace.
    this.#resetPreview();

    // A snapshot, so moving the slider mid-run cannot change what is running.
    const settings: PdfCompressSettings = { ...this.settings };

    try {
      const bytes = await this.file.arrayBuffer();
      // Stop pressed while the file was still being read: never start the run.
      if (controller.signal.aborted) {
        this.phase = 'ready';
        return;
      }

      const result = await this.#compress(bytes, settings, {
        signal: controller.signal,
        onProgress: (done, total) => {
          this.progress = { done, total };
        },
      });

      // An abort landing in the gap between the last image and `doc.save()`
      // still resolves. The user asked to stop; do not present the output.
      if (controller.signal.aborted) {
        this.phase = 'ready';
        return;
      }

      this.result = result;
      this.phase = 'done';
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        this.phase = 'ready';
      } else {
        this.error = messageOf(error);
        this.phase = 'error';
      }
    } finally {
      if (this.#controller === controller) this.#controller = undefined;
    }
  }

  /** Stop an in-flight run. The phase rewinds to `'ready'`, not `'error'`. */
  abort(): void {
    this.#controller?.abort();
  }

  /**
   * Show page `index` of the before/after, rendering it if it is not cached.
   *
   * Out-of-range indices are clamped rather than refused, so the view can wire
   * its arrows to `previewPage ± 1` and let the ends look after themselves. The
   * page number moves immediately; the pixels follow.
   *
   * Calling this again supersedes whatever was in flight — the render nobody is
   * waiting for is aborted, not awaited.
   */
  async showPage(index: number): Promise<void> {
    const total = this.pageCount;
    const page = clampPageIndex(index, total);
    this.previewPage = page;
    this.previewError = undefined;

    // Whatever was rendering is for a page nobody is looking at any more.
    this.#previewController?.abort();
    this.#previewController = undefined;

    const result = this.result;
    if (!result || total === 0) {
      this.preview = undefined;
      this.previewLoading = false;
      return;
    }

    const cached = this.#cache.find((entry) => entry.pageIndex === page);
    if (cached) {
      this.#cache = cachePreviewPages(this.#cache, cached);
      this.preview = cached;
      this.previewLoading = false;
      return;
    }

    const controller = new AbortController();
    this.#previewController = controller;
    this.previewLoading = true;

    try {
      const renderers = await this.#openRenderers(result);
      if (controller.signal.aborted) return;

      // Both sides are measured from the original and rendered at that one
      // scale. The rewrite only swaps image streams, so the geometry matches —
      // but measuring each side separately would let a rounding difference
      // become a visible jump across the divider.
      const size = await renderers.original.pageSize(page);
      const scale = fitScale(size, PREVIEW_BOX, PREVIEW_MAX_SCALE);
      const [original, output] = await Promise.all([
        renderers.original.render(controller.signal, page, scale),
        renderers.output.render(controller.signal, page, scale),
      ]);
      if (controller.signal.aborted) return;

      const rendered: PdfPreviewPage = { pageIndex: page, original, output };
      this.#cache = cachePreviewPages(this.#cache, rendered);
      this.preview = rendered;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return;
      // One side failing does not stop the other: `Promise.all` rejects on the
      // first rejection and leaves its sibling running. That sibling is still
      // executing its operator list in rAF slices on the UI thread, and would
      // finish with a multi-megabyte `getImageData` readback nobody holds — for
      // a page the user has just been told failed. Abort so it stops at the next
      // slice; the signal is this render's alone, so nothing else is affected.
      controller.abort();
      this.previewError = messageOf(error, 'Rendering this page failed');
    } finally {
      // A newer page took over while this one was rendering: the flag is its
      // business now, and clearing it here would hide its spinner.
      if (this.#previewController === controller) {
        this.#previewController = undefined;
        this.previewLoading = false;
      }
    }
  }

  /** Called from `onDestroy`: nothing must outlive the view. */
  dispose(): void {
    this.abort();
    this.#controller = undefined;
    this.#resetPreview();
  }

  /**
   * Both documents, opened once and held across page changes.
   *
   * Reparsing a 150 MB file every time an arrow is pressed is the one cost a
   * preview cannot afford, and it is the only reason these handles are cached
   * rather than opened per render.
   *
   * Only a *fulfilled* promise is kept. Caching a rejected one would make the
   * first failure permanent: opening can fail for reasons that are transient by
   * nature — a chunk that 404s mid-deploy, a `PdfWorkerError` from a stale
   * cached worker — and the sentence those raise tells the user to reload and
   * try again. Replaying the settled rejection on every arrow press would make
   * that advice a lie, since nothing short of a recompress calls
   * `#resetPreview`. `loadPdfjs` in `render.ts` drops its own cache on failure
   * for the same reason; the two must agree.
   */
  #openRenderers(result: PdfCompressResult): Promise<PdfRendererPair> {
    const open = this.#renderers;
    if (open) return open;

    const opening = (async (): Promise<PdfRendererPair> => {
      // `file.arrayBuffer()` hands back a fresh copy every call, so the
      // original side needs no defence. `result.bytes` does: pdf.js takes
      // ownership of the buffer it is given and may detach it, and that same
      // buffer is what the download button writes — opening the preview would
      // otherwise quietly empty the file the user is about to save.
      //
      // `openPdfRenderer` copies again internally, and the duplication is kept
      // deliberately: `#openRenderer` is an injected seam, this is the only
      // level at which "the download's bytes survive a preview" is expressible
      // as a test (see pdf-job.test.ts), and the second buffer is transient —
      // garbage the moment `getDocument` has taken its own.
      const original = await this.#openRenderer(await this.file.arrayBuffer());
      try {
        return { original, output: await this.#openRenderer(result.bytes.slice(0)) };
      } catch (error) {
        // Half an open pair is a pdf.js worker nothing will ever close.
        original.destroy();
        throw error;
      }
    })();

    this.#renderers = opening;
    // Guarded on identity: a `#closeRenderers()` racing the failure has already
    // moved on, and clearing unconditionally would wipe its replacement.
    opening.catch(() => {
      if (this.#renderers === opening) this.#renderers = undefined;
    });
    return opening;
  }

  /** Drop both handles. Safe mid-open: the pair is destroyed when it lands. */
  #closeRenderers(): void {
    const open = this.#renderers;
    this.#renderers = undefined;
    if (!open) return;
    void open.then(destroyRenderers, () => undefined);
  }

  /**
   * Forget everything rendered from the previous output.
   *
   * {@link previewPage} deliberately survives: a re-run is a change of
   * settings, not of document, and the page being judged is the whole reason
   * the user changed them.
   */
  #resetPreview(): void {
    this.#previewController?.abort();
    this.#previewController = undefined;
    this.#closeRenderers();
    this.#cache = [];
    this.preview = undefined;
    this.previewLoading = false;
    this.previewError = undefined;
  }
}

/** The factory the view uses, mirroring `createBatchQueue` / `createTabs`. */
export function createPdfJob(file: File, deps?: PdfJobDeps): PdfJob {
  return new PdfJob(file, deps);
}

/** Best-effort human text for anything thrown out of the engine. */
function messageOf(error: unknown, fallback = 'Compressing failed'): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

/** Close both documents. Each one holds a pdf.js worker until it is destroyed. */
function destroyRenderers(pair: PdfRendererPair): void {
  pair.original.destroy();
  pair.output.destroy();
}
