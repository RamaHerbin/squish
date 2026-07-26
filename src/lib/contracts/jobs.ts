/**
 * The job engine: the thing that turns "user moved a slider" into
 * "a new encoded file appeared on side 1", without ever showing a stale result.
 *
 * ## Model
 * Two independent editor sides share one decoded source. Each side tracks two
 * settings snapshots:
 *
 * - `latestSettings` — what the UI currently shows. Updates instantly.
 * - `encodedSettings` — what actually produced `file`. Lags behind while work
 *   is in flight, and is `undefined` until the first encode lands.
 *
 * `latestSettings !== encodedSettings` is exactly "the preview is out of date",
 * which is what drives the loading affordances.
 *
 * ## Abort semantics (hierarchical)
 * - **Main controller** — decode + preprocess. Aborted when the source file or
 *   {@link PreprocessorState} changes. Because both sides depend on the
 *   preprocessed pixels, aborting it necessarily restarts both sides.
 * - **Per-side controllers** (one each) — process + encode. Aborted when only
 *   that side's {@link SideSettings} changed, so the other side keeps its
 *   in-flight work.
 *
 * A controller is never reused: on abort it is replaced with a fresh
 * `AbortController`. Every async step must call {@link assertSignal} on entry
 * and wrap awaited promises in {@link abortable}. `AbortError` rejections are
 * swallowed by the engine (they are expected), anything else surfaces as
 * `error` on the relevant slice of state.
 *
 * At the worker layer, abort means terminate — see `worker.ts`.
 *
 * ## Debounce
 * Work is queued through a {@link JOB_DEBOUNCE_MS} trailing debounce, matching
 * Squoosh. Slider drags therefore coalesce into one encode instead of dozens,
 * which is what stops iOS Safari from running out of memory. Source loads
 * bypass the debounce (`immediate`).
 *
 * Dependency-free: types and tiny pure helpers only.
 */

import type { BrowserEncoderId, EncoderId, AnyEncoderOptions } from './codecs';
import type { SourceImage } from './image';
import type { PreprocessorState, ProcessorState, SideSettings } from './processing';

/* -------------------------------------------------------------------------- */
/* Sides                                                                       */
/* -------------------------------------------------------------------------- */

/** 0 = left (reference), 1 = right (candidate). */
export type SideIndex = 0 | 1;

export const SIDES: readonly SideIndex[] = [0, 1];

export function otherSide(side: SideIndex): SideIndex {
  return side === 0 ? 1 : 0;
}

/* -------------------------------------------------------------------------- */
/* Reactive outputs                                                            */
/* -------------------------------------------------------------------------- */

/** Everything the UI needs to render one side. All fields are reactive. */
export interface SideOutput {
  /** True while this side has processing or encoding in flight. */
  loading: boolean;
  /**
   * Pixels to display. Set to an intermediate value (the freshly preprocessed
   * source) as soon as the source changes so the canvas is never blank, then
   * replaced by the round-tripped decode of {@link SideOutput.file}.
   */
  data?: ImageData;
  /** Encoded output, named after the source with the encoder's extension. */
  file?: File;
  /**
   * `URL.createObjectURL(file)`. The engine owns its lifetime and revokes it
   * whenever `file` is replaced or the engine is disposed — never revoke it
   * from the UI, and never share one URL across sides.
   */
  downloadUrl?: string;
  /** The settings that produced {@link SideOutput.file}. */
  encodedSettings?: SideSettings;
  /** What the UI is currently showing; may be ahead of `encodedSettings`. */
  latestSettings: SideSettings;
  /** Human-readable failure from the last attempt. Cleared on the next success. */
  error?: string;
  /**
   * Set when the wasm codec worker failed and this side fell back to the named
   * canvas encoder. The output is a valid file but not byte-identical to the
   * wasm codec — the UI flags it. Cleared whenever the wasm path succeeds.
   */
  encoderFallback?: BrowserEncoderId;
}

/** Whole-engine reactive state. */
export interface JobEngineState {
  /** Undefined until the first decode completes. */
  source?: SourceImage;
  /** True while decoding or preprocessing the source. */
  loading: boolean;
  /** Source-level failure (bad file, unsupported type, decode error). */
  error?: string;
  /** What the UI currently shows for shared preprocessing. */
  preprocessorState: PreprocessorState;
  /** The preprocessor state the current preprocessed pixels were produced with. */
  encodedPreprocessorState?: PreprocessorState;
  sides: [SideOutput, SideOutput];
}

/** True when anything at all is in flight. Drives the document-title spinner. */
export function isBusy(state: JobEngineState): boolean {
  return state.loading || state.sides[0].loading || state.sides[1].loading;
}

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

export type JobEvent =
  | { type: 'source-loading'; file: File }
  | { type: 'source-decoded'; source: SourceImage }
  | { type: 'source-error'; error: Error }
  | { type: 'side-start'; side: SideIndex; settings: SideSettings }
  | { type: 'side-encoded'; side: SideIndex; file: File; settings: SideSettings }
  | { type: 'side-error'; side: SideIndex; error: Error }
  | { type: 'idle' };

export type JobEventListener = (event: JobEvent) => void;

/* -------------------------------------------------------------------------- */
/* Engine                                                                      */
/* -------------------------------------------------------------------------- */

/** Trailing debounce before heavy work starts, in ms. */
export const JOB_DEBOUNCE_MS = 100;

export interface JobEngineOptions {
  /** Override {@link JOB_DEBOUNCE_MS}; `0` disables debouncing (tests). */
  debounceMs?: number;
  /** Override {@link RESULT_CACHE_SIZE}. */
  cacheSize?: number;
}

/**
 * Implemented by the state layer as a `.svelte.ts` store: `state` is a `$state`
 * object, so reading `engine.state.sides[1].loading` inside a component or
 * `$derived` subscribes to it. All mutating methods are synchronous and return
 * void — they only schedule work.
 */
export interface JobEngine {
  /** Reactive engine state. Read-only from the UI's perspective. */
  readonly state: JobEngineState;

  /**
   * Load a new source. Aborts everything in flight, clears both sides' outputs,
   * and reseeds each side's resize width/height from the decoded dimensions
   * (with `enabled: false`, so the change is visible rather than silent).
   * Runs immediately, bypassing the debounce.
   */
  setSource(file: File): void;

  /** Replace one side's `latestSettings`. Debounced. */
  updateSide(side: SideIndex, settings: SideSettings): void;

  /** Patch one side's processor state, leaving the encoder alone. Debounced. */
  updateProcessor(side: SideIndex, processorState: ProcessorState): void;

  /**
   * Replace the shared preprocessor state. Debounced.
   * A 90°/270° rotation change swaps each side's resize width/height so the
   * user's target dimensions still mean what they meant before.
   */
  updatePreprocessor(state: PreprocessorState): void;

  /** Copy `from`'s settings onto the other side, minting a fresh object URL. */
  copySettings(from: SideIndex): void;

  /** Abort in-flight work without clearing results. */
  abort(): void;

  /** Run any pending debounced work now and resolve once the engine is idle. */
  flush(): Promise<void>;

  subscribe(listener: JobEventListener): () => void;

  /**
   * Abort everything, terminate workers, revoke object URLs. The engine is
   * unusable afterwards.
   */
  dispose(): void;
}

/* -------------------------------------------------------------------------- */
/* Result cache                                                                */
/* -------------------------------------------------------------------------- */

/** Entries retained by the LRU. Matches Squoosh's cache depth. */
export const RESULT_CACHE_SIZE = 5;

export interface ResultCacheEntry {
  /** Identity-compared: the exact preprocessed `ImageData` this came from. */
  preprocessed: ImageData;
  processorState: ProcessorState;
  encoderId: EncoderId;
  encoderOptions: AnyEncoderOptions;
  /** Pixels after processing, before encoding. */
  processed: ImageData;
  /** Pixels decoded back from {@link ResultCacheEntry.file}, for the preview. */
  data: ImageData;
  file: File;
  /**
   * The browser encoder that produced {@link ResultCacheEntry.file} when the
   * wasm worker had failed, mirroring {@link SideOutput.encoderFallback}. Cached
   * so a later hit re-labels the degraded output instead of presenting it as the
   * selected wasm codec's result.
   */
  encoderFallback?: BrowserEncoderId;
}

/** What a cache hit hands back — the produced artefacts only. */
export type ResultCacheHit = Pick<
  ResultCacheEntry,
  'processed' | 'data' | 'file' | 'encoderFallback'
>;

/**
 * Small LRU keyed on (preprocessed identity, processor state, encoder + options).
 * Lets a user scrub a slider back to a previous value and get an instant result.
 * Implementations must move a hit to the front and evict from the back.
 */
export interface ResultCache {
  add(entry: ResultCacheEntry): void;
  match(
    preprocessed: ImageData,
    processorState: ProcessorState,
    encoderId: EncoderId,
    encoderOptions: AnyEncoderOptions,
  ): ResultCacheHit | undefined;
  clear(): void;
}

/* -------------------------------------------------------------------------- */
/* Abort helpers                                                               */
/* -------------------------------------------------------------------------- */

/** The canonical abort rejection. `err.name === 'AbortError'`. */
export function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * The codec worker never finished loading (bad chunk, top-level throw, a
 * sub-resource blocked by COEP, …). Comlink calls to such a worker never settle
 * on their own, so the bridge listens for the worker's `error`/`messageerror`
 * and rejects everything in flight with this instead of hanging forever.
 */
export class WorkerLoadError extends Error {
  constructor(
    message = 'The codec worker failed to load. Reload the page and try again.',
  ) {
    super(message);
    this.name = 'WorkerLoadError';
  }
}

/**
 * The worker loaded but an encode/decode call produced no result within the
 * bridge's watchdog window (typically a wasm-threads deadlock). The bridge
 * terminates the worker and rejects the call with this.
 */
export class WorkerTimeoutError extends Error {
  constructor(message = 'Encoding timed out — the codec worker stopped responding.') {
    super(message);
    this.name = 'WorkerTimeoutError';
  }
}

/**
 * A worker failure the caller can recover from (surface an error, or fall back
 * to a browser encoder). Distinct from {@link isAbortError}, which must stay
 * silent because the user or a newer job caused it.
 */
export function isWorkerFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'WorkerLoadError' || error.name === 'WorkerTimeoutError')
  );
}

/** Throw immediately if the signal has already fired. Call at every step entry. */
export function assertSignal(signal: AbortSignal): void {
  if (signal.aborted) throw createAbortError();
}

/**
 * Reject as soon as `signal` fires, otherwise settle with `promise`.
 *
 * The underlying work keeps running (you cannot un-ring a wasm call) — this
 * only stops the *result* from being awaited. Terminate the worker if you need
 * the CPU back.
 */
export async function abortable<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  assertSignal(signal);
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(createAbortError()), { once: true });
    }),
  ]);
}
