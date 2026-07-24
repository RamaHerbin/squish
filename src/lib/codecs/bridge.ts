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
  type CreateWorkerBridge,
  type EncoderOptionsMap,
  type RotateAngle,
  type WorkerBridgeApi,
  type WorkerDecodableMimeType,
  type WorkerEncoderId,
  type WorkerResizeOptions,
} from '../contracts';
import type { CodecWorkerApi } from './codec.worker';

/** How long a worker may sit idle before it is terminated. Matches Squoosh. */
export const WORKER_IDLE_TIMEOUT_MS = 10_000;

export interface WorkerBridgeOptions {
  /** Worker factory. Override in tests to inject a fake endpoint. */
  createWorker?: () => Worker;
  /** Override {@link WORKER_IDLE_TIMEOUT_MS}. `Infinity` disables the timer. */
  idleTimeoutMs?: number;
}

/**
 * The one place the worker URL appears.
 *
 * `new URL(..., import.meta.url)` is the form Vite statically analyses, so the
 * worker gets its own bundle with its own dynamic-import chunks for each codec.
 */
function spawnCodecWorker(): Worker {
  return new Worker(new URL('./codec.worker.ts', import.meta.url), { type: 'module' });
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

  private readonly spawn: () => Worker;
  private readonly idleTimeoutMs: number;

  constructor(options: WorkerBridgeOptions = {}) {
    this.spawn = options.createWorker ?? spawnCodecWorker;
    this.idleTimeoutMs = options.idleTimeoutMs ?? WORKER_IDLE_TIMEOUT_MS;
  }

  /* ---------------------------------------------------------------------- */
  /* Worker lifecycle                                                        */
  /* ---------------------------------------------------------------------- */

  private connect(): Remote {
    if (!this.api) {
      this.worker = this.spawn();
      this.api = Comlink.wrap<CodecWorkerApi>(this.worker);
    }
    return this.api;
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

  terminate(): void {
    this.clearIdleTimer();

    if (this.worker) {
      this.worker.terminate();
      this.worker = undefined;
      this.api = undefined;
    }

    if (this.inFlight.size > 0) {
      // Comlink calls to a dead worker never settle on their own; the messages
      // simply go nowhere. Settle them here so awaiting callers unblock.
      const pending = [...this.inFlight];
      this.inFlight.clear();
      for (const reject of pending) reject(createAbortError());
    }
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

  private async execute<T>(
    signal: AbortSignal,
    task: (api: Remote) => Promise<T>,
  ): Promise<T> {
    assertSignal(signal);
    this.clearIdleTimer();

    const api = this.connect();
    const onAbort = () => this.terminate();
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      return await abortable(signal, this.track(task(api)));
    } finally {
      signal.removeEventListener('abort', onAbort);
      // Only arm the idle timer if a worker survived this call — an aborted
      // call already terminated it.
      if (this.worker) this.scheduleIdleTerminate();
    }
  }

  /** Queue a call behind everything already in flight on this worker. */
  private run<T>(signal: AbortSignal, task: (api: Remote) => Promise<T>): Promise<T> {
    const result = this.queue.then(() => this.execute(signal, task));
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
    return this.run(signal, async (api) => {
      const payload = await api.decode(mimeType, Comlink.transfer(buffer, [buffer]));
      return fromTransferable(payload);
    });
  }

  encode<K extends WorkerEncoderId>(
    signal: AbortSignal,
    id: K,
    data: ImageData,
    options: EncoderOptionsMap[K],
  ): Promise<ArrayBuffer> {
    return this.run(signal, (api) =>
      api.encode(id, toTransferable(data), options as WorkerEncoderOptions),
    );
  }

  resize(
    signal: AbortSignal,
    data: ImageData,
    options: WorkerResizeOptions,
  ): Promise<ImageData> {
    return this.run(signal, async (api) =>
      fromTransferable(await api.resize(toTransferable(data), options)),
    );
  }

  /**
   * `0°` short-circuits and hands the *same* `ImageData` back — no round trip,
   * no copy. Treat the result as read-only, which the pipeline does anyway.
   */
  rotate(signal: AbortSignal, data: ImageData, angle: RotateAngle): Promise<ImageData> {
    if (angle === 0) return Promise.resolve(data);
    return this.run(signal, async (api) =>
      fromTransferable(await api.rotate(toTransferable(data), angle)),
    );
  }

  preload(id: WorkerEncoderId): void {
    const controller = new AbortController();
    void this.run(controller.signal, (api) => api.preload(id)).catch(() => {
      // Warm-up is advisory; a failure here is not the user's problem.
    });
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
