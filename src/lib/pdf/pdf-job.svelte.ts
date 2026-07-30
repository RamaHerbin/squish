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

/** The two engine calls, injectable so tests need neither canvas nor worker. */
export interface PdfJobDeps {
  analyze?: typeof analyzePdf;
  compress?: typeof compressPdf;
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

  readonly #analyze: typeof analyzePdf;
  readonly #compress: typeof compressPdf;
  #controller: AbortController | undefined;

  constructor(file: File, deps: PdfJobDeps = {}) {
    this.file = file;
    this.#analyze = deps.analyze ?? analyzePdf;
    this.#compress = deps.compress ?? compressPdf;
  }

  /** True while a run is in flight — the view's Compress/Stop switch. */
  get running(): boolean {
    return this.phase === 'compressing';
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
   * A no-op unless the analysis cleared the document (`'ready'`) or a previous
   * run finished (`'done'`, so the rail can be re-tuned and re-run). Never
   * concurrent: `'compressing'` falls through the same guard.
   */
  async compress(): Promise<void> {
    if (this.phase !== 'ready' && this.phase !== 'done') return;
    const analysis = this.analysis;
    // Belt and braces: the phase already implies a clean analysis, and a run
    // without one cannot tell "refused" from "nothing to do".
    if (!analysis || analysis.refusal) return;

    const controller = new AbortController();
    this.#controller = controller;
    this.phase = 'compressing';
    this.result = undefined;
    this.error = undefined;
    this.progress = { done: 0, total: analysis.images.length };

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

  /** Called from `onDestroy`: nothing must outlive the view. */
  dispose(): void {
    this.abort();
    this.#controller = undefined;
  }
}

/** The factory the view uses, mirroring `createBatchQueue` / `createTabs`. */
export function createPdfJob(file: File, deps?: PdfJobDeps): PdfJob {
  return new PdfJob(file, deps);
}

/** Best-effort human text for anything thrown out of the engine. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string' && error) return error;
  return 'Compressing failed';
}
