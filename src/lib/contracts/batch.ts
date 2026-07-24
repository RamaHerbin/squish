/**
 * Batch mode: apply one set of settings to many files, then download a zip.
 *
 * Deliberately separate from the job engine. The editor optimises for latency
 * on a single image (debounce, LRU cache, two competing sides); the batch queue
 * optimises for throughput on many (bounded concurrency, no cache, one
 * settings snapshot taken at start).
 *
 * Dependency-free: types and tiny pure helpers only.
 */

import type { SideSettings } from './processing';

/* -------------------------------------------------------------------------- */
/* Items                                                                       */
/* -------------------------------------------------------------------------- */

export type BatchItemStatus = 'pending' | 'processing' | 'done' | 'error';

export interface BatchItem {
  /** Stable identity for keyed lists. See {@link createBatchItemId}. */
  id: string;
  /** Source filename, as shown in the list. */
  name: string;
  status: BatchItemStatus;
  /** Source size in bytes. */
  srcSize: number;
  /** Output size in bytes. Present once `status === 'done'`. */
  outSize?: number;
  /** Failure message. Present only when `status === 'error'`. */
  error?: string;

  /** The input file. Held so the queue can be re-run with new settings. */
  file: File;
  /** The encoded result. Present once `status === 'done'`. */
  outFile?: File;
  /**
   * Object URL for {@link BatchItem.outFile}, for per-item download links.
   * Owned by the queue; revoked on `clear()`, `remove()` and re-runs.
   */
  downloadUrl?: string;
}

/** `outSize / srcSize`. `undefined` until the item is done. */
export function compressionRatio(item: BatchItem): number | undefined {
  if (item.outSize === undefined || item.srcSize === 0) return undefined;
  return item.outSize / item.srcSize;
}

/* -------------------------------------------------------------------------- */
/* Progress                                                                    */
/* -------------------------------------------------------------------------- */

export interface BatchProgress {
  /** Total items in the queue. */
  total: number;
  /** Items with `status === 'done'`. */
  done: number;
  /** Items with `status === 'error'`. */
  errored: number;
  /** Items currently `processing`. Never exceeds `concurrency`. */
  processing: number;
  /** True between `start()` and completion/cancellation. */
  running: boolean;
  /** Summed `srcSize` over completed items. */
  bytesIn: number;
  /** Summed `outSize` over completed items. */
  bytesOut: number;
}

/** 0–1 over settled (done + errored) items. `1` for an empty queue. */
export function progressFraction(progress: BatchProgress): number {
  if (progress.total === 0) return 1;
  return (progress.done + progress.errored) / progress.total;
}

/* -------------------------------------------------------------------------- */
/* Queue                                                                       */
/* -------------------------------------------------------------------------- */

/** Default parallel encodes — one worker per lane, capped to stay memory-sane. */
export const DEFAULT_BATCH_CONCURRENCY = 4;

export interface BatchQueueOptions {
  /** Parallel encodes. Defaults to {@link DEFAULT_BATCH_CONCURRENCY}. */
  concurrency?: number;
}

/**
 * Implemented by the state layer as a `.svelte.ts` store; `items` and
 * `progress` are `$state`/`$derived` and can be read directly in markup.
 *
 * A failing item never stops the run — it is marked `error` and the queue moves
 * on, so one corrupt file in a drop of two hundred doesn't cost the user the
 * other 199.
 */
export interface BatchQueue {
  readonly items: readonly BatchItem[];
  readonly progress: BatchProgress;
  readonly concurrency: number;

  /** Append files as `pending` items. Returns the items created. */
  add(files: readonly File[] | FileList): BatchItem[];
  /** Drop one item, revoking its object URL. Ignored while it is processing. */
  remove(id: string): void;
  /** Drop everything and revoke all object URLs. */
  clear(): void;

  /**
   * Encode every `pending` item with `settings`.
   *
   * The settings are snapshotted at call time — later edits do not affect a run
   * in progress. `settings.processorState.resize` is applied per image, so a
   * `contain` fit gives consistent output dimensions across mixed inputs.
   *
   * Resolves when the queue drains or is cancelled; never rejects for
   * individual item failures.
   */
  start(settings: SideSettings): Promise<void>;

  /**
   * Abort the run. In-flight items return to `pending`; `done` items keep their
   * results. Idempotent.
   */
  cancel(): void;

  /** Reset every non-pending item back to `pending`, discarding outputs. */
  reset(): void;
}

/* -------------------------------------------------------------------------- */
/* Zip export                                                                  */
/* -------------------------------------------------------------------------- */

export interface ZipExportOptions {
  /**
   * Deflate level 0–9 passed to `fflate`. Defaults to `0` (store): the payload
   * is already-compressed image data, so deflating it burns CPU for ~0 gain.
   */
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  /** Optional progress callback, `0–1`. */
  onProgress?: (fraction: number) => void;
  /** Signal to abort zipping. Rejects with an `AbortError`. */
  signal?: AbortSignal;
}

/**
 * Bundle every `done` item into a zip. Items in any other status are skipped.
 *
 * Name collisions (two `photo.png` from different folders) must be resolved by
 * suffixing — see {@link dedupeFilename}.
 */
export type ZipExport = (
  items: readonly BatchItem[],
  options?: ZipExportOptions,
) => Promise<Blob>;

/** Suggested download name for the bundle. */
export const BATCH_ZIP_FILENAME = 'squished.zip';

/**
 * Return `name` if unused, else insert ` (2)`, ` (3)`… before the extension.
 * Mutates `used` so it can be threaded through a loop.
 */
export function dedupeFilename(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const match = /^(.*?)(\.[^./\\]*)$/.exec(name);
  const stem = match?.[1] ?? name;
  const ext = match?.[2] ?? '';
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/** Collision-resistant id for a queue item. */
export function createBatchItemId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
