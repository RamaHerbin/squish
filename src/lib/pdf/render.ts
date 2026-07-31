/**
 * Rasterise whole PDF pages, so a compression result can be *looked at* rather
 * than only tallied.
 *
 * This is the only module in the codebase allowed to touch `pdfjs-dist`, and it
 * exists because nothing else can do the job: `@cantoo/pdf-lib` (the engine's
 * parser) is structural — it can rewrite an image XObject but has no interpreter
 * for a content stream — and `placement.ts` is a lexer that recovers CTMs, not a
 * renderer. A before/after of a *page* needs a real PDF renderer.
 *
 * ## Everything expensive is deferred
 *
 * `pdfjs-dist` is imported dynamically inside {@link openPdfRenderer}. A static
 * import would be fatal for the entry chunk: `PdfView` is statically reachable
 * from `App.svelte`, so pdf.js (~455 KB min) would land next to pdf-lib in the
 * bundle every visitor downloads, whether or not they ever open a PDF. The
 * dynamic form makes Rollup cut it into a chunk only PDF users pay for.
 *
 * The `?url` import below is *not* pdf.js code — it is a build-time string
 * naming an emitted asset — so it costs the entry chunk nothing.
 *
 * ## The worker, and why it is asserted rather than assumed
 *
 * See {@link openWorker}. pdf.js does not throw when its worker fails to start;
 * it silently rasterises on the main thread instead. That failure mode is the
 * exact one this repository has already shipped a fix for elsewhere, so it is
 * detected here and turned into a {@link PdfWorkerError}.
 *
 * ## Scale is a viewport fit, never a DPI
 *
 * Callers pass a scale from {@link fitScale}. Rendering "at 300 DPI" is the
 * obvious-looking choice and is a trap: A4 at 300 DPI is ~8.7 M pixels, i.e.
 * 35 MB of RGBA *per side* of a two-up comparison, for a raster that is then
 * drawn into a few hundred CSS pixels. {@link MAX_RENDER_PIXELS} backstops a
 * caller that asks for more anyway.
 */

import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type {
  PageViewport,
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  PDFWorker,
  RenderTask,
} from 'pdfjs-dist';

import { assertSignal, abortable, createAbortError } from '../contracts';

/** The pdf.js module namespace, named without importing it at runtime. */
type PdfjsModule = typeof import('pdfjs-dist');

/* -------------------------------------------------------------------------- */
/* Auxiliary asset URLs                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Where the pdf.js side-car data lives, for a given `pdfjs-dist` version.
 *
 * The layout is not a free choice here — it is fixed by the two other places
 * that already implement it, and this is the only code that actually *asks* for
 * the files. `vite.config.ts`'s `pdfjs-assets` plugin copies them into
 * `assets/pdfjs/<version>/` at build time and serves that exact path out of
 * `node_modules` in dev; `shell/sw.ts` runtime-caches the `/assets/pdfjs/`
 * prefix. A base of anything else (a top-level `/pdfjs/`, say) misses all
 * three, and the miss is *silent*: `vercel.json` rewrites everything outside
 * `/assets/` to `index.html`, so the fetch returns 200 `text/html`, which then
 * gets parsed as a CMap or handed to `WebAssembly.instantiate` — and pdf.js
 * runs with `ignoreErrors` on, so the page simply loses its images.
 *
 * The version segment comes from pdf.js's own export, never typed here. It is
 * what makes the `immutable, max-age=1y` already declared for `/assets/` honest
 * for these files: their names are hardcoded inside `pdf.worker.mjs`
 * (`qcms_bg.wasm` and friends), so Vite cannot content-hash them, and without
 * the version an upgrade would serve new bytes at a URL browsers and service
 * workers had pinned for a year.
 *
 * pdf.js validates the two strings itself: `getFactoryUrlProp` throws unless
 * they end in `/`, because it concatenates a bare filename onto them.
 *
 * - `cmaps/` — the 169 `.bcmap` files, needed by any document with a CJK
 *   encoding. `fetchBuiltInCMap` in the worker has **no** `try`/`catch`: a
 *   missing cmap throws once per font and takes the page render with it, so
 *   this one is not optional.
 * - `wasm/` — `openjpeg.wasm` (JPX), `jbig2.wasm` and `qcms_bg.wasm`. Scanned
 *   documents — the ones most worth compressing — are exactly the ones that
 *   carry JPX and JBIG2 images.
 *
 * Deliberately absent: `standardFontDataUrl`. `fetchStandardFontData` *does*
 * have a `try`/`catch` — it warns and returns `null`, and the text falls back to
 * a system font. That degradation is 800 KB cheaper and, crucially, harmless
 * here: this renderer only ever produces *pairs* of rasters from the same
 * document, so both sides substitute the same font in the same place and the
 * drift cancels out in the comparison. `iccUrl` is skipped for the same reason —
 * a CMYK page loses its ICC-accurate colour identically on both sides.
 *
 * Exported for `render.test.ts`, which is the only thing that can catch this
 * drifting again: every fetch below it is invisible to the unit suite, and the
 * e2e fixture is Latin text with DCT images, so it asks for neither directory.
 */
export function pdfjsAssetUrls(version: string): { cMapUrl: string; wasmUrl: string } {
  const base = `${import.meta.env.BASE_URL}assets/pdfjs/${version}/`;
  return { cMapUrl: `${base}cmaps/`, wasmUrl: `${base}wasm/` };
}

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Hard ceiling on the scale a caller may ask for. 4× a PDF's native 72 DPI user
 * space is 288 DPI — past any screen's ability to show the difference.
 */
export const MAX_RENDER_SCALE = 4;

/** Floor, purely so a degenerate box can never produce a zero-size canvas. */
export const MIN_RENDER_SCALE = 0.01;

/**
 * Backstop on the raster itself, applied after the scale clamp because a caller
 * can ask for a modest scale on an enormous page (posters, plans, CAD exports).
 * 4 MP is 16 MB of RGBA per side, 32 MB for the pair — the point where mobile
 * Safari starts refusing canvases.
 */
export const MAX_RENDER_PIXELS = 4_000_000;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The pdf.js worker is not running — either it never started, or pdf.js quietly
 * substituted its main-thread "fake worker".
 *
 * Distinct from the codecs' `WorkerLoadError` because it is a different worker
 * with a different remedy, and because `isWorkerFailure()` deliberately gates on
 * the codec pipeline's two names.
 */
export class PdfWorkerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfWorkerError';
  }
}

/** A page could not be rasterised for a reason that is not an abort. */
export class PdfRenderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfRenderError';
  }
}

/* -------------------------------------------------------------------------- */
/* Public shape                                                                */
/* -------------------------------------------------------------------------- */

/** One rasterised page. `width`/`height` mirror `data`, after every clamp. */
export interface RenderedPage {
  readonly data: ImageData;
  readonly width: number;
  readonly height: number;
}

export interface PdfRenderer {
  readonly pageCount: number;
  /**
   * Rasterise a 0-based page index at `scale`. Rejects with an `AbortError`
   * `DOMException` if `signal` aborts.
   */
  render(signal: AbortSignal, pageIndex: number, scale: number): Promise<RenderedPage>;
  /** Natural CSS-pixel size of a page at scale 1, for fit maths. */
  pageSize(pageIndex: number): Promise<{ width: number; height: number }>;
  destroy(): void;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers — no pdf.js, unit-testable in Node                             */
/* -------------------------------------------------------------------------- */

/**
 * Largest scale that fits `page` inside `box`, capped at `maxScale`.
 *
 * Pure and DPR-agnostic: pass a box already multiplied by whatever device pixel
 * ratio you intend to render at, and both sides of a comparison will agree
 * because they are the same page geometry fed through the same function.
 *
 * A non-finite or non-positive input yields {@link MIN_RENDER_SCALE} rather than
 * `NaN`/`Infinity` — a zero-size box happens for one frame on mount, and the
 * caller should get a tiny raster, not a crash.
 */
export function fitScale(
  page: { width: number; height: number },
  box: { width: number; height: number },
  maxScale: number = MAX_RENDER_SCALE,
): number {
  const cap = Number.isFinite(maxScale) && maxScale > 0 ? maxScale : MAX_RENDER_SCALE;
  if (!isPositive(page.width) || !isPositive(page.height)) return MIN_RENDER_SCALE;
  if (!isPositive(box.width) || !isPositive(box.height)) return MIN_RENDER_SCALE;
  const raw = Math.min(box.width / page.width, box.height / page.height);
  return Math.max(MIN_RENDER_SCALE, Math.min(raw, cap));
}

/**
 * Clamp a page index into `[0, pageCount)`.
 *
 * Truncates, so a fractional index from an animation or a slider lands on a real
 * page, and collapses every nonsense input to `0` — a document always has a
 * first page, and refusing to show one would be a worse answer than showing it.
 */
export function clampPageIndex(index: number, pageCount: number): number {
  if (!Number.isFinite(pageCount) || pageCount < 1) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), Math.trunc(pageCount) - 1);
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/* -------------------------------------------------------------------------- */
/* Module loading                                                              */
/* -------------------------------------------------------------------------- */

let modulePromise: Promise<PdfjsModule> | undefined;

/**
 * Import pdf.js once and point it at a same-origin worker.
 *
 * `workerSrc` is set here rather than at module scope so nothing evaluates
 * `location` on import — `render.ts` has to stay loadable in Node, like every
 * other module in this directory.
 *
 * The URL comes from `?worker`-adjacent territory for a measured reason,
 * documented at `codecs/bridge.ts:88`: Vite's `new Worker(new URL(...))`
 * rewrite is a regex over source text, and it cannot fire here at all because
 * the `new Worker` call lives inside pdf.js, not in our source. `?url` is the
 * supported way to ask Vite to emit a file and hand back its URL. Plain `?url`
 * rather than `?worker&url`: `pdf.worker.min.mjs` is already a self-contained ES
 * bundle with nothing to resolve, and re-bundling it would rename it to `.js`,
 * which is one of the extensions the service worker precaches — megabytes added
 * to the shell for every visitor, PDF user or not.
 *
 * `.min` for the same reason that `?url` is used at all: `?url` copies the file
 * *verbatim*, with no transform, so the unminified entry point would ship
 * 2.22 MB where the minified one is 1.26 MB — of identical, self-contained code
 * — and pin the extra ~960 KB in `squish-pdfjs` under a one-year `immutable`
 * TTL. `sw.ts` already routes both spellings.
 *
 * Same-origin is not a preference. A cross-origin `workerSrc` makes pdf.js
 * rewrite it into a `createObjectURL` shim that `import()`s the CDN copy, and
 * that path is dead under `Cross-Origin-Embedder-Policy: require-corp`.
 *
 * A failed import clears the cache so a later attempt can retry; a chunk that
 * 404s once during a deploy usually resolves on the next navigation.
 */
function loadPdfjs(): Promise<PdfjsModule> {
  if (!modulePromise) {
    modulePromise = import('pdfjs-dist')
      .then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(pdfWorkerUrl, location.href).href;
        return pdfjs;
      })
      .catch((error: unknown) => {
        modulePromise = undefined;
        throw error;
      });
  }
  return modulePromise;
}

/* -------------------------------------------------------------------------- */
/* The worker assertion                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Start a pdf.js worker and **prove** it is a real one.
 *
 * The failure this guards against is silent by design. When `new Worker()`
 * throws, or the script errors, or the handshake never completes, pdf.js calls
 * `#setupFakeWorker()`: it logs `warn('Setting up fake worker.')`, dynamically
 * imports `pdf.worker.mjs` *on the main thread*, and resolves normally. Every
 * subsequent call then renders on the UI thread — a multi-second freeze per
 * page, with no rejection anywhere for the app to react to. Worse, the
 * `#isWorkerDisabled` latch is `static`, so one failure silently downgrades
 * every renderer created afterwards.
 *
 * The signal chosen is **`PDFWorker.port instanceof Worker`**, read after
 * `worker.promise` settles. It is trustworthy because of where pdf.js assigns
 * that field (`build/pdf.mjs`, `PDFWorker#initialize`): `#port` is only ever set
 * to the `Worker` object from inside the `messageHandler.on('test', …)`
 * callback — i.e. after a message has made a full round trip through the real
 * worker. Every other route assigns something that is *not* a `Worker`: the
 * fake path installs a `LoopbackPort`, and the `{ port }` constructor path (which
 * we never take, since we pass no port and never set `GlobalWorkerOptions.
 * workerPort`) installs a `MessagePort`. So the check is not "did construction
 * avoid throwing" — it is a liveness proof.
 *
 * `worker.promise` is also guaranteed to settle: the fake-worker path resolves
 * it, and a fake-worker setup that itself fails rejects it. There is no hang to
 * time out.
 *
 * The declared type of `.port` is `Worker`, which is a lie in exactly the case
 * being tested for; it is read as `unknown` so the narrowing is honest.
 */
async function openWorker(pdfjs: PdfjsModule): Promise<PDFWorker> {
  const worker = new pdfjs.PDFWorker();

  try {
    await worker.promise;
  } catch (error) {
    worker.destroy();
    throw new PdfWorkerError(
      'The PDF renderer worker could not be started. Reload the page and try again.',
      { cause: error },
    );
  }

  const port: unknown = worker.port;
  if (!(port instanceof Worker)) {
    worker.destroy();
    throw new PdfWorkerError(
      'The PDF renderer fell back to rendering on the main thread, which would freeze ' +
        'the page. Reload and try again — this usually means a cached copy of the ' +
        'worker script predates the site’s COOP/COEP headers.',
    );
  }

  return worker;
}

/* -------------------------------------------------------------------------- */
/* Renderer                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Open a document for rasterising. Lazily imports pdf.js on first call.
 *
 * `bytes` is **copied**. `getDocument` wraps whatever it is given in a
 * `Uint8Array` (a *view*, for an `ArrayBuffer` — verified in `getDataProp`) and
 * then hands `data.buffer` to `sendWithPromise(…, [data.buffer])`, whose third
 * argument is the transfer list. The caller's buffer would come back detached,
 * and both of this feature's buffers are long-lived and re-read: `PdfJob.file`
 * is the user's original and `PdfCompressResult.bytes` is what the download
 * button writes out.
 */
export async function openPdfRenderer(bytes: ArrayBuffer): Promise<PdfRenderer> {
  const pdfjs = await loadPdfjs();
  const worker = await openWorker(pdfjs);

  const { cMapUrl, wasmUrl } = pdfjsAssetUrls(pdfjs.version);
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes.slice(0)),
    worker,
    cMapUrl,
    cMapPacked: true,
    wasmUrl,
  });

  try {
    const doc = await task.promise;
    return new PdfJsRenderer(task, doc, worker);
  } catch (error) {
    // The worker is ours, not the loading task's (passing `worker` leaves
    // `task._worker` null), so nothing else will ever terminate it.
    void task.destroy().catch(() => undefined);
    worker.destroy();
    throw error;
  }
}

class PdfJsRenderer implements PdfRenderer {
  private destroyed = false;
  /** Live render tasks, so `destroy()` can stop work already on the wire. */
  private readonly inFlight = new Set<RenderTask>();

  constructor(
    // Teardown goes through the *loading task*, not the document: pdf.js 6
    // dropped `PDFDocumentProxy.destroy()`, and the task is the only handle that
    // still waits for the transport before letting go.
    private readonly task: PDFDocumentLoadingTask,
    private readonly doc: PDFDocumentProxy,
    private readonly worker: PDFWorker,
  ) {}

  get pageCount(): number {
    return this.doc.numPages;
  }

  async pageSize(pageIndex: number): Promise<{ width: number; height: number }> {
    const page = await this.page(pageIndex);
    // Via the viewport, not `/MediaBox`: `getViewport` folds in `/Rotate` and
    // `/UserUnit`, so a landscape-by-rotation page reports the size it will
    // actually rasterise at instead of its stored portrait box.
    const { width, height } = page.getViewport({ scale: 1 });
    return { width, height };
  }

  async render(signal: AbortSignal, pageIndex: number, scale: number): Promise<RenderedPage> {
    assertSignal(signal);
    // A destroyed renderer means the view that owned it is gone. `AbortError` is
    // the rejection the job pipeline already swallows silently, which is the
    // right outcome for a result nobody is waiting for any more.
    if (this.destroyed) throw createAbortError();

    const page = await abortable(signal, this.page(pageIndex));
    assertSignal(signal);

    const viewport = this.viewportFor(page, scale);
    // Floor, not round: a canvas one pixel wider than the viewport would leave
    // an unpainted column that reads as a seam under the reveal divider.
    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const task = page.render({ canvas, viewport });
    this.inFlight.add(task);
    // `RenderTask.cancel()` is the only real cancellation available: the
    // operator list is executed in rAF-sized slices, and cancelling stops the
    // next slice instead of letting a page nobody wants keep burning frames.
    const onAbort = () => task.cancel();
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      await task.promise;
    } catch (error) {
      // pdf.js rejects a cancelled task with `RenderingCancelledException`,
      // which is neither a `DOMException` nor named `AbortError`. Translate it
      // so callers only ever have to recognise one abort shape.
      if (signal.aborted || this.destroyed) throw createAbortError();
      throw new PdfRenderError(`Page ${pageIndex + 1} could not be rendered.`, { cause: error });
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.inFlight.delete(task);
    }

    try {
      // A late abort still skips the readback: `getImageData` on a full page is
      // a synchronous multi-megabyte copy, and nobody is waiting for it.
      assertSignal(signal);
      // Same context object pdf.js drew into — `getContext('2d')` returns the
      // existing one and ignores the attributes on every call after the first.
      const context = canvas.getContext('2d');
      if (!context) throw new PdfRenderError('This browser refused a 2D canvas context.');
      return { data: context.getImageData(0, 0, width, height), width, height };
    } finally {
      // Drop the backing store now rather than waiting for GC. Two of these are
      // alive at once during a comparison, and Safari accounts canvas memory
      // against a process-wide budget that a few stale pages can exhaust.
      canvas.width = 0;
      canvas.height = 0;
      // And pdf.js's own copy, which nothing else will ever drop. A *successful*
      // render leaves the proxy holding its operator list and `objs` — where the
      // decoded images land — because `PDFPageProxy#complete` only re-arms
      // `#pendingCleanup` for print intent, and `WorkerTransport` caches every
      // proxy for the life of the document. Note the asymmetry: a *cancelled*
      // render self-cleans via `_abortOperatorList`, so it is precisely the pages
      // the user looked at that accumulate — ~35 MB for one 300 DPI A4 scan,
      // twice over for a comparison, unbounded and entirely separate from the
      // caller's two-entry `ImageData` cache. Here is the one point where it is
      // free: the task is already out of `renderTasks` and the operator list is
      // complete, so `#tryCleanup` passes both guards instead of no-oping. The
      // cost is one more operator-list round trip if the same page is rendered
      // again, which that cache already makes rare.
      page.cleanup();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const task of this.inFlight) task.cancel();
    this.inFlight.clear();
    // Order matters: the document teardown talks to the worker, so the worker
    // can only be terminated once that round trip has settled either way.
    void this.task
      .destroy()
      .catch(() => undefined)
      .finally(() => this.worker.destroy());
  }

  private async page(pageIndex: number): Promise<PDFPageProxy> {
    // pdf.js numbers pages from 1 and caches the proxies internally, so there is
    // nothing to memoise here.
    return this.doc.getPage(clampPageIndex(pageIndex, this.doc.numPages) + 1);
  }

  /**
   * The viewport actually rendered: the requested scale, clamped, then reduced
   * again if the resulting raster would blow past {@link MAX_RENDER_PIXELS}.
   *
   * Deterministic in `(page geometry, scale)` alone, which is what lets the two
   * sides of a reveal be rasterised independently and still line up exactly.
   */
  private viewportFor(page: PDFPageProxy, scale: number): PageViewport {
    const requested = Number.isFinite(scale)
      ? Math.max(MIN_RENDER_SCALE, Math.min(scale, MAX_RENDER_SCALE))
      : MIN_RENDER_SCALE;

    const viewport = page.getViewport({ scale: requested });
    const pixels = viewport.width * viewport.height;
    if (pixels <= MAX_RENDER_PIXELS) return viewport;

    return page.getViewport({ scale: requested * Math.sqrt(MAX_RENDER_PIXELS / pixels) });
  }
}
