/**
 * Main-thread client for `metrics.worker.ts`.
 *
 * Same three behaviours as the codec bridge (`src/lib/codecs/bridge.ts`), for
 * the same reasons — read that file first if you are changing this one:
 *
 * 1. **Lazy spawn.** No worker until the first comparison; terminated again
 *    after {@link METRICS_IDLE_TIMEOUT_MS} of silence. An editor left open on a
 *    finished image holds nothing.
 * 2. **Serialisation.** One comparison at a time through a promise queue. SSIM
 *    is a CPU burst on a big Float32Array; two of them interleaved in one
 *    worker only makes both slower and doubles peak memory.
 * 3. **Abort is terminate.** A running SSIM loop cannot be interrupted from the
 *    outside, so cancelling means killing the worker, rejecting everything in
 *    flight with an `AbortError`, and respawning on the next call. That is
 *    cheap here: the metrics worker is stateless, with no wasm to re-warm.
 *
 * ## Copy semantics
 * The worker **transfers its inputs in**, so `measure` sends *copies*: the
 * caller keeps its decoded original and its preview pixels intact. That is one
 * memcpy per image per comparison, which is far cheaper than the compare
 * itself, and it means the editor can measure while the canvas is still
 * painting from the same buffers.
 *
 * ## Failure vs. abort
 * `measure` only ever rejects on abort (`err.name === 'AbortError'`). Anything
 * else — mismatched dimensions because Resize is on, an empty image, a broken
 * worker — resolves as `{ ssim: null, error }`, because "we could not measure
 * this" is a normal, displayable state (`SSIM —`) and not something a screen
 * should have to try/catch around.
 */

import {
  abortable,
  assertSignal,
  cloneTransferable,
  createAbortError,
  isAbortError,
  transferListFor,
  type MetricsResult,
} from '../contracts';
import type { MetricsRequest, MetricsResponse } from './metrics.worker';
import { METRICS_MAX_PIXELS, sameDimensions, type MetricsImage } from './ssim';

/** How long the worker may sit idle before it is terminated. Matches the codec bridge. */
export const METRICS_IDLE_TIMEOUT_MS = 10_000;

/**
 * {@link MetricsResult} plus the reason it came back unmeasured. Structurally a
 * `MetricsResult`, so it drops straight into anything typed against the
 * contract; `error` is there for a tooltip and for debugging.
 */
export interface MetricsMeasurement extends MetricsResult {
  error?: string;
}

export interface MetricsClientOptions {
  /** Worker factory. Override in tests to inject a fake. */
  createWorker?: () => Worker;
  /** Override {@link METRICS_IDLE_TIMEOUT_MS}. `Infinity` disables the timer. */
  idleTimeoutMs?: number;
  /** Pixel budget per image before box-averaging. See `ssim.ts`. */
  maxPixels?: number;
}

/**
 * The one place the worker URL appears — `new URL(..., import.meta.url)` is the
 * form Vite statically analyses into its own chunk.
 */
function spawnMetricsWorker(): Worker {
  return new Worker(new URL('./metrics.worker.ts', import.meta.url), { type: 'module' });
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

interface Pending {
  resolve(response: MetricsResponse): void;
  reject(reason: unknown): void;
}

export class MetricsClient {
  /** Tail of the serialisation chain. Never rejects (rejections are absorbed). */
  private queue: Promise<void> = Promise.resolve();
  private worker: Worker | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  private readonly spawn: () => Worker;
  private readonly idleTimeoutMs: number;
  /** Pixel budget handed to the worker with every request. */
  readonly maxPixels: number;

  constructor(options: MetricsClientOptions = {}) {
    this.spawn = options.createWorker ?? spawnMetricsWorker;
    this.idleTimeoutMs = options.idleTimeoutMs ?? METRICS_IDLE_TIMEOUT_MS;
    this.maxPixels = options.maxPixels ?? METRICS_MAX_PIXELS;
  }

  /* ---------------------------------------------------------------------- */
  /* Public API                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Compare an encode against the original.
   *
   * Both images are copied before they are sent, so the caller's buffers stay
   * valid. Different dimensions resolve as `{ ssim: null }` — that is the
   * Resize-is-on case, not an error.
   *
   * @param original the source pixels (side 0 / `identity`).
   * @param output   the encode's pixels, decoded back to RGBA.
   * @param signal   abort to terminate the worker and reject with `AbortError`.
   */
  async measure(
    original: MetricsImage,
    output: MetricsImage,
    signal?: AbortSignal,
  ): Promise<MetricsMeasurement> {
    const started = now();

    if (original.width <= 0 || original.height <= 0) {
      return { ssim: null, ms: now() - started, error: 'empty image' };
    }
    if (!sameDimensions(original, output)) {
      return {
        ssim: null,
        ms: now() - started,
        error: `dimensions differ (${original.width}x${original.height} vs ${output.width}x${output.height})`,
      };
    }

    // A signal is always present internally so `execute` has one thing to
    // listen to; a caller-less measurement simply gets one that never fires.
    const effective = signal ?? new AbortController().signal;

    try {
      const response = await this.run(effective, (worker) =>
        this.send(worker, original, output),
      );
      const ms = now() - started;
      return response.ok
        ? { ssim: response.ssim, ms }
        : { ssim: null, ms, error: response.error };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return { ssim: null, ms: now() - started, error: describe(error) };
    }
  }

  /** Terminate the worker and reject everything in flight. Safe to call twice. */
  terminate(): void {
    this.clearIdleTimer();

    if (this.worker) {
      this.worker.removeEventListener('message', this.onMessage);
      this.worker.removeEventListener('error', this.onFailure);
      this.worker.removeEventListener('messageerror', this.onFailure);
      this.worker.terminate();
      this.worker = undefined;
    }

    if (this.pending.size > 0) {
      // Replies to a dead worker never arrive; settle the promises here so
      // awaiting callers unblock instead of hanging forever.
      const waiting = [...this.pending.values()];
      this.pending.clear();
      for (const entry of waiting) entry.reject(createAbortError());
    }
  }

  /** Alias for {@link MetricsClient.terminate}, for symmetry with the stores. */
  dispose(): void {
    this.terminate();
  }

  /* ---------------------------------------------------------------------- */
  /* Worker lifecycle                                                        */
  /* ---------------------------------------------------------------------- */

  private connect(): Worker {
    if (!this.worker) {
      const worker = this.spawn();
      worker.addEventListener('message', this.onMessage);
      worker.addEventListener('error', this.onFailure);
      worker.addEventListener('messageerror', this.onFailure);
      this.worker = worker;
    }
    return this.worker;
  }

  private readonly onMessage = (event: MessageEvent<MetricsResponse>): void => {
    const response = event.data;
    if (!response || typeof response.id !== 'number') return;
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    entry.resolve(response);
  };

  private readonly onFailure = (event: Event): void => {
    // Read `message` structurally rather than through `instanceof ErrorEvent`,
    // which is not a global in every environment this file is loaded in.
    const detail = (event as { message?: unknown }).message;
    const reason = new Error(
      typeof detail === 'string' && detail
        ? `metrics worker failed: ${detail}`
        : 'metrics worker failed',
    );

    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const entry of waiting) entry.reject(reason);

    // The worker is in an unknown state — drop it and start clean next call.
    this.terminate();
  };

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

  /* ---------------------------------------------------------------------- */
  /* Call plumbing                                                           */
  /* ---------------------------------------------------------------------- */

  /** Copy both images, post them with a transfer list, await the reply. */
  private send(
    worker: Worker,
    original: MetricsImage,
    output: MetricsImage,
  ): Promise<MetricsResponse> {
    const id = this.nextId++;
    const request: MetricsRequest = {
      id,
      a: cloneTransferable(original),
      b: cloneTransferable(output),
      maxPixels: this.maxPixels,
    };

    const reply = new Promise<MetricsResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    try {
      worker.postMessage(request, [
        ...transferListFor(request.a),
        ...transferListFor(request.b),
      ]);
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }

    return reply;
  }

  private async execute<T>(
    signal: AbortSignal,
    task: (worker: Worker) => Promise<T>,
  ): Promise<T> {
    assertSignal(signal);
    this.clearIdleTimer();

    const worker = this.connect();
    const onAbort = () => this.terminate();
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      return await abortable(signal, task(worker));
    } finally {
      signal.removeEventListener('abort', onAbort);
      // Only re-arm the idle timer if a worker survived this call.
      if (this.worker) this.scheduleIdleTerminate();
    }
  }

  /** Queue a call behind everything already in flight on this worker. */
  private run<T>(signal: AbortSignal, task: (worker: Worker) => Promise<T>): Promise<T> {
    const result = this.queue.then(() => this.execute(signal, task));
    // Keep the queue flowing however this call ends, without the tail looking
    // like an unhandled rejection while the caller still holds `result`.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/* -------------------------------------------------------------------------- */
/* Factories                                                                   */
/* -------------------------------------------------------------------------- */

/** A client owning its own worker. */
export function createMetricsClient(options: MetricsClientOptions = {}): MetricsClient {
  return new MetricsClient(options);
}

let shared: MetricsClient | undefined;

/**
 * Process-wide client.
 *
 * Unlike the codec bridge this one is safe to share: measurements are
 * stateless and serialised, and an abort only costs the other callers a
 * respawn, not a warm wasm module. The editor, the matrix sweep and
 * auto-suggest all use it so there is never more than one metrics worker alive.
 */
export function getSharedMetricsClient(): MetricsClient {
  if (!shared) shared = createMetricsClient();
  return shared;
}

/** Terminate and forget the shared client. */
export function disposeSharedMetricsClient(): void {
  shared?.terminate();
  shared = undefined;
}
