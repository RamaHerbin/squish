/**
 * Main-thread bridge to one codec worker.
 *
 * Ported from Squoosh's `client/lazy-app/worker-bridge`, with the same three
 * behaviours that make wasm codecs usable in a UI:
 *
 * 1. **Lazy spawn.** No worker exists until the first call. After
 *    {@link WORKER_IDLE_TIMEOUT_MS} of silence it is terminated again, so a tab
 *    left open on a finished image is not holding 100 MB of warm wasm.
 * 2. **Serialisation.** Every call goes through a promise queue. wasm codecs
 *    are single-threaded per module and allocate aggressively; running two
 *    encodes concurrently in one worker is how iOS Safari gets OOM-killed.
 * 3. **Abort is terminate.** A wasm call cannot be interrupted once it has
 *    entered the module, so the only real cancellation is killing the worker.
 *    The bridge does exactly that, rejects everything in flight with an
 *    `AbortError`, and spawns a fresh worker on the next call.
 *
 * Because a terminate throws away every warm wasm instance, **give each editor
 * side its own bridge** — otherwise aborting side 1's slider drag also
 * discards side 0's freshly initialised encoder.
 *
 * ## Copy semantics
 * - `encode` / `resize` / `rotate` take an `ImageData` the caller still owns,
 *   so pixels are sent by structured clone (one copy) rather than transferred.
 *   Results come back transferred, since the worker's copy is disposable.
 * - `decode` **transfers** its `ArrayBuffer`: the compressed bytes are read
 *   straight off a `File` and the worker consumes them. The buffer is detached
 *   on return — do not reuse it.
 */

import * as Comlink from 'comlink';

import {
  abortable,
  assertSignal,
  createAbortError,
  fromTransferable,
  toTransferable,
  SINGLE_THREADED_PARAM,
  WorkerLoadError,
  WorkerTimeoutError,
  type CreateWorkerBridge,
  type EncoderOptionsMap,
  type RotateAngle,
  type WorkerBridgeApi,
  type WorkerDecodableMimeType,
  type WorkerEncoderId,
  type WorkerResizeOptions,
} from '../contracts';
import type { CodecWorkerApi } from './codec.worker';
import codecWorkerUrl from './codec.worker.ts?worker&url';

/** How long a worker may sit idle before it is terminated. Matches Squoosh. */
export const WORKER_IDLE_TIMEOUT_MS = 10_000;

/**
 * Watchdog for a call that loaded a worker but never comes back — a wasm-threads
 * deadlock, say. A worker that *fails to load* is caught instantly by the
 * `error` listener; this only backstops a worker that wedged mid-call. The
 * budget scales with the image so a genuinely heavy encode never false-fires: a
 * truly hung worker emits nothing regardless of size, so even the ceiling
 * catches it, while a real 24 MP AVIF stays comfortably under.
 */
export const WORKER_WATCHDOG_BASE_MS = 20_000;
export const WORKER_WATCHDOG_PER_MP_MS = 4_000;
export const WORKER_WATCHDOG_CEIL_MS = 120_000;

export interface WorkerBridgeOptions {
  /**
   * Worker factory. Override in tests to inject a fake endpoint.
   *
   * `nothreads` is `true` once this bridge has latched single-threaded mode
   * after a load failure; the default factory turns it into
   * `?nothreads=1` on the worker URL. A zero-argument override still satisfies
   * this type, so existing fakes keep working.
   */
  createWorker?: (nothreads: boolean) => Worker;
  /** Override {@link WORKER_IDLE_TIMEOUT_MS}. `Infinity` disables the timer. */
  idleTimeoutMs?: number;
  /**
   * Watchdog budget. `'auto'` (default) scales with the call's pixel count; a
   * number pins a flat budget; `Infinity` disables the watchdog entirely.
   */
  watchdogMs?: number | 'auto';
}

/**
 * The one place the worker URL appears.
 *
 * Not the usual `new Worker(new URL('./codec.worker.ts', import.meta.url))`,
 * because the bridge has to put a query on that URL and Vite's worker analysis
 * is a *regex over the source text*: it only rewrites a `new Worker(`
 * immediately followed by `new URL(<string literal>, import.meta.url)`. Lift
 * the `new URL` into a variable to mutate it and the pattern stops matching —
 * at which point the build emits `codec.worker.ts` as a raw asset instead of
 * bundling it, no codec chunk is reachable, and every wasm codec dies. That is
 * not a guess: `npm run build` drops from 70 precached files to 34.
 *
 * `?worker&url` asks for exactly the same thing through the supported door —
 * Vite runs the identical `workerFileToUrl` bundling and hands back the built
 * chunk's URL as a string, leaving us free to shape it.
 *
 * Resolving against `location.href` rather than `import.meta.url` matches what
 * `new Worker(<string>)` would have done — Vite's asset URLs are relative to
 * the document, not to the chunk that mentions them.
 */
function spawnCodecWorker(nothreads: boolean): Worker {
  const url = new URL(codecWorkerUrl, location.href);
  // A distinct URL is also a distinct HTTP cache entry, which is a bonus here:
  // the retry cannot be served the same stale copy that caused the failure.
  if (nothreads) url.searchParams.set(SINGLE_THREADED_PARAM, '1');
  return new Worker(url, { type: 'module' });
}

/* -------------------------------------------------------------------------- */
/* Failure diagnosis                                                           */
/* -------------------------------------------------------------------------- */

/** The fields an `ErrorEvent` adds on top of `Event`, read structurally. */
interface WorkerErrorFields {
  readonly message?: unknown;
  readonly filename?: unknown;
  readonly lineno?: unknown;
  readonly colno?: unknown;
}

/**
 * What the browser actually said about a worker failure.
 *
 * Two very different events arrive on the same listener, and flattening them
 * into one string is what made the production failure undiagnosable:
 *
 * - a **bare `Event`** means the *script response* was rejected before a line of
 *   it ran — a 404, a network error, or a cached copy without a
 *   `Cross-Origin-Embedder-Policy` header, which a cross-origin-isolated page
 *   refuses to instantiate. The browser supplies no detail here *by design*, so
 *   name the likely causes instead of printing `[object Event]`.
 * - an **`ErrorEvent`** means the worker ran and threw. `filename`/`lineno` name
 *   the chunk, which is the only way to tell *which* codec died.
 *
 * Read structurally rather than with `instanceof ErrorEvent`: that constructor
 * does not exist in Node, where this file's tests run.
 */
function describeWorkerFailure(event: Event): string {
  const { message, filename, lineno, colno } = event as Event & WorkerErrorFields;

  let at = '';
  if (typeof filename === 'string' && filename) {
    const line = typeof lineno === 'number' ? lineno : undefined;
    const column = typeof colno === 'number' ? colno : 0;
    at = line === undefined ? ` in ${filename}` : ` in ${filename}:${line}:${column}`;
  }

  if (typeof message === 'string' && message) return `${message}${at}`;
  if (at) return `no error detail${at}`;
  if (event.type === 'messageerror') return 'a worker message could not be deserialised';
  return (
    'the browser refused the worker script without saying why — usually a cached ' +
    'copy predating COOP/COEP, or a missing chunk'
  );
}

/** The single user-facing wording, so both failure paths read identically. */
function workerLoadError(detail: string): WorkerLoadError {
  return new WorkerLoadError(
    `The codec worker failed to load (${detail}). Reload the page and try again.`,
  );
}

/**
 * Internal hand-back from `onWorkerError` to `execute`: *this worker died, the
 * bridge has latched threads off, run the call again*. It never escapes the
 * bridge — `execute` either retries or converts it to a {@link WorkerLoadError}.
 */
class SingleThreadedRetry extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'SingleThreadedRetry';
  }
}

type Remote = Comlink.Remote<CodecWorkerApi>;

/**
 * Comlink erases the generic on `encode`, so its remote signature takes the
 * union of every wasm codec's options. The correlation between `id` and
 * `options` is enforced by this class' own generic signature instead.
 */
type WorkerEncoderOptions = EncoderOptionsMap[WorkerEncoderId];

class CodecWorkerBridge implements WorkerBridgeApi {
  /** Tail of the serialisation chain. Never rejects (rejections are absorbed). */
  private queue: Promise<void> = Promise.resolve();
  private worker: Worker | undefined;
  private api: Remote | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Rejectors for calls currently awaiting the worker, so terminate can settle them. */
  private readonly inFlight = new Set<(reason: unknown) => void>();
  /**
   * Latched by the first load failure. Every worker spawned afterwards asks for
   * the single-threaded wasm builds, for the rest of this bridge's life. It is
   * deliberately one-way: nested workers that a document refused once are not
   * going to start being allowed later in the same document.
   */
  private threadsBroken = false;

  private readonly spawn: (nothreads: boolean) => Worker;
  private readonly idleTimeoutMs: number;
  private readonly watchdogMs: number | 'auto';

  constructor(options: WorkerBridgeOptions = {}) {
    this.spawn = options.createWorker ?? spawnCodecWorker;
    this.idleTimeoutMs = options.idleTimeoutMs ?? WORKER_IDLE_TIMEOUT_MS;
    this.watchdogMs = options.watchdogMs ?? 'auto';
  }

  /* ---------------------------------------------------------------------- */
  /* Worker lifecycle                                                        */
  /* ---------------------------------------------------------------------- */

  private connect(): Remote {
    if (!this.api) {
      const worker = this.spawn(this.threadsBroken);
      // Comlink never observes a worker that fails to load — the encode message
      // just goes nowhere and the call hangs. Listen for the worker's own
      // failure events and settle everything in flight loudly instead.
      worker.addEventListener('error', this.onWorkerError);
      worker.addEventListener('messageerror', this.onWorkerError);
      this.worker = worker;
      this.api = Comlink.wrap<CodecWorkerApi>(worker);
    }
    return this.api;
  }

  /**
   * A load/instantiation failure of the worker itself — never settles on its own.
   *
   * The failure that actually happens in production is not this worker's script
   * but a *nested* one: the threaded wasm builds start emscripten's pthread
   * pool, and a browser that refuses one of those scripts leaves emscripten
   * rethrowing a bare `Event` straight out of our worker. So the first failure
   * is not reported to the user at all. It latches threads off and hands the
   * in-flight call back to {@link execute}, which runs it again on a fresh
   * worker that will not touch threads. Only a failure *after* the latch is a
   * genuine one worth a {@link WorkerLoadError}.
   */
  private readonly onWorkerError = (event: Event): void => {
    const detail = describeWorkerFailure(event);
    const firstFailure = !this.threadsBroken;
    // Latch before the worker goes away: connect() reads it on the next spawn.
    this.threadsBroken = true;
    this.disposeWorker();
    this.failInFlight(
      firstFailure ? new SingleThreadedRetry(detail) : workerLoadError(detail),
    );
  };

  /** Tear the worker down without settling callers. Callers pick the reason. */
  private disposeWorker(): void {
    if (!this.worker) return;
    this.worker.removeEventListener('error', this.onWorkerError);
    this.worker.removeEventListener('messageerror', this.onWorkerError);
    this.worker.terminate();
    this.worker = undefined;
    this.api = undefined;
  }

  /**
   * Reject every call awaiting the worker. Comlink calls to a dead worker never
   * settle on their own — the messages simply go nowhere — so settle them here.
   */
  private failInFlight(reason: unknown): void {
    if (this.inFlight.size === 0) return;
    const pending = [...this.inFlight];
    this.inFlight.clear();
    for (const reject of pending) reject(reason);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === undefined) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdleTerminate(): void {
    this.clearIdleTimer();
    if (!Number.isFinite(this.idleTimeoutMs)) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.terminate();
    }, this.idleTimeoutMs);
  }

  /** Budget for the watchdog. `Infinity` means no watchdog for this call. */
  private watchdogBudget(pixels?: number): number {
    if (this.watchdogMs !== 'auto') return this.watchdogMs;
    if (pixels === undefined) return WORKER_WATCHDOG_CEIL_MS;
    const megapixels = pixels / 1_000_000;
    return Math.min(
      WORKER_WATCHDOG_CEIL_MS,
      WORKER_WATCHDOG_BASE_MS + megapixels * WORKER_WATCHDOG_PER_MP_MS,
    );
  }

  terminate(): void {
    this.clearIdleTimer();
    this.disposeWorker();
    this.failInFlight(createAbortError());
  }

  /* ---------------------------------------------------------------------- */
  /* Call plumbing                                                           */
  /* ---------------------------------------------------------------------- */

  /** Reject `promise` early if the worker is terminated underneath it. */
  private track<T>(promise: Promise<T>): Promise<T> {
    let reject!: (reason: unknown) => void;
    const killed = new Promise<never>((_resolve, rejectKilled) => {
      reject = rejectKilled;
    });

    this.inFlight.add(reject);
    return Promise.race([promise, killed]).finally(() => {
      this.inFlight.delete(reject);
    });
  }

  /**
   * Run a call, and — when the worker died on this bridge's *first* load
   * failure — run it once more on the single-threaded worker the latch now
   * selects.
   *
   * The retry is silent by design: a slower successful encode beats a dead app,
   * and "your browser cached a worker script without a COEP header" is not
   * something a user can act on. There is no third attempt — the second failure
   * arrives as a plain {@link WorkerLoadError} because the latch is already set.
   */
  private async execute<T>(
    signal: AbortSignal,
    task: (api: Remote) => Promise<T>,
    budgetMs: number,
    retryable: boolean,
  ): Promise<T> {
    try {
      return await this.attempt(signal, task, budgetMs);
    } catch (error) {
      if (!(error instanceof SingleThreadedRetry)) throw error;
      if (!retryable) throw workerLoadError(error.detail);
      return await this.attempt(signal, task, budgetMs);
    }
  }

  private async attempt<T>(
    signal: AbortSignal,
    task: (api: Remote) => Promise<T>,
    budgetMs: number,
  ): Promise<T> {
    assertSignal(signal);
    this.clearIdleTimer();

    const api = this.connect();
    const onAbort = () => this.terminate();
    signal.addEventListener('abort', onAbort, { once: true });

    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const tracked = this.track(task(api));
      if (!Number.isFinite(budgetMs)) {
        return await abortable(signal, tracked);
      }
      const timedOut = new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => {
          // Reject the OUTER promise first so it wins this race. terminate()
          // rejects the tracked call with an AbortError, which #runSide
          // swallows — leaning on that would re-hang the spinner. Then reclaim
          // the CPU; the worker respawns on the next call. The already-settled
          // race still holds a handler on `tracked`, so its later AbortError is
          // not an unhandled rejection.
          reject(new WorkerTimeoutError());
          this.terminate();
        }, budgetMs);
      });
      return await abortable(signal, Promise.race([tracked, timedOut]));
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
      signal.removeEventListener('abort', onAbort);
      // Only arm the idle timer if a worker survived this call — an aborted or
      // timed-out call already terminated it.
      if (this.worker) this.scheduleIdleTerminate();
    }
  }

  /**
   * Queue a call behind everything already in flight on this worker.
   *
   * `retryable` says whether `task` may be run a second time — see
   * {@link execute}. Only {@link decode} says no.
   */
  private run<T>(
    signal: AbortSignal,
    task: (api: Remote) => Promise<T>,
    budgetMs: number,
    retryable = true,
  ): Promise<T> {
    const result = this.queue.then(() => this.execute(signal, task, budgetMs, retryable));
    // The queue must keep flowing regardless of how this call ends, and must
    // not look like an unhandled rejection while the caller holds `result`.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /* ---------------------------------------------------------------------- */
  /* WorkerBridgeApi                                                         */
  /* ---------------------------------------------------------------------- */

  decode(
    signal: AbortSignal,
    mimeType: WorkerDecodableMimeType,
    buffer: ArrayBuffer,
  ): Promise<ImageData> {
    return this.run(
      signal,
      async (api) => {
        const payload = await api.decode(mimeType, Comlink.transfer(buffer, [buffer]));
        return fromTransferable(payload);
      },
      this.watchdogBudget(),
      // The one call that cannot be retried: `buffer` is transferred into the
      // worker on the first attempt and detached here afterwards, so there is
      // nothing left to send. Nothing is lost — jSquash ships threaded builds
      // for *encoders* only, so a decode never selects the code path the retry
      // exists for.
      false,
    );
  }

  encode<K extends WorkerEncoderId>(
    signal: AbortSignal,
    id: K,
    data: ImageData,
    options: EncoderOptionsMap[K],
  ): Promise<ArrayBuffer> {
    return this.run(
      signal,
      (api) => api.encode(id, toTransferable(data), options as WorkerEncoderOptions),
      this.watchdogBudget(data.width * data.height),
    );
  }

  resize(
    signal: AbortSignal,
    data: ImageData,
    options: WorkerResizeOptions,
  ): Promise<ImageData> {
    return this.run(
      signal,
      async (api) => fromTransferable(await api.resize(toTransferable(data), options)),
      this.watchdogBudget(data.width * data.height),
    );
  }

  /**
   * `0°` short-circuits and hands the *same* `ImageData` back — no round trip,
   * no copy. Treat the result as read-only, which the pipeline does anyway.
   */
  rotate(signal: AbortSignal, data: ImageData, angle: RotateAngle): Promise<ImageData> {
    if (angle === 0) return Promise.resolve(data);
    return this.run(
      signal,
      async (api) => fromTransferable(await api.rotate(toTransferable(data), angle)),
      this.watchdogBudget(data.width * data.height),
    );
  }

  preload(id: WorkerEncoderId): void {
    const controller = new AbortController();
    // Warm-up is advisory, but it still rides the serial queue: an Infinity
    // budget on a deadlocked wasm `init()` would block every queued encode
    // behind it, so its own watchdog could never start. Give preload the same
    // no-pixel watchdog so a wedged init terminates and the queue drains.
    void this.run(controller.signal, (api) => api.preload(id), this.watchdogBudget()).catch(
      () => {
        // A failure here is not the user's problem.
      },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Factories                                                                   */
/* -------------------------------------------------------------------------- */

/** Create a bridge owning its own worker. One per editor side. */
export function createWorkerBridge(options: WorkerBridgeOptions = {}): WorkerBridgeApi {
  return new CodecWorkerBridge(options);
}

/** The zero-argument factory shape the contracts hand around for injection. */
export const createDefaultWorkerBridge: CreateWorkerBridge = () => createWorkerBridge();

let shared: WorkerBridgeApi | undefined;

/**
 * A lazily created, process-wide bridge.
 *
 * For incidental work — a batch item, a feature probe, a one-shot decode. The
 * editor must not use it: an abort on any caller terminates it for everyone.
 */
export function getSharedWorkerBridge(): WorkerBridgeApi {
  if (!shared) shared = createWorkerBridge();
  return shared;
}

/** Terminate and forget the shared bridge. */
export function disposeSharedWorkerBridge(): void {
  shared?.terminate();
  shared = undefined;
}
