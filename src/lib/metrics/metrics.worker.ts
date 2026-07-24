/**
 * The metrics worker: SSIM off the main thread.
 *
 * Deliberately **not** Comlink. The codec worker needs Comlink because it has a
 * six-method API with generics; this one has a single call, so a bare
 * `postMessage` protocol keeps the worker chunk down to `ssim.ts` and nothing
 * else — no proxy, no dependency, and a message shape that a test can fake in
 * five lines.
 *
 * ## Protocol
 * ```
 * main → worker   { id, a, b, maxPixels? }        // MetricsRequest
 * worker → main   { id, ok: true,  ssim, ms }     // MetricsResponse
 *                 { id, ok: false, error, ms }
 * ```
 *
 * ## Transfers
 * `a` and `b` are **transferred in** — their buffers are detached on the main
 * thread the moment `postMessage` returns. `metrics-client.ts` therefore sends
 * *copies*: the editor keeps its decoded original and its preview pixels, and
 * the worker gets buffers it is free to consume. The reply carries only
 * numbers, so nothing is transferred back.
 *
 * ## Lifetime
 * Stateless. Every request is self-contained, which is what lets the client
 * terminate the worker on abort or after 10 s idle and respawn it later with no
 * warm-up cost — there is no wasm module in here, just arithmetic.
 */

import { METRICS_MAX_PIXELS, computeSsim, downscalePairForMetrics } from './ssim';
import type { MetricsImage } from './ssim';

/* -------------------------------------------------------------------------- */
/* Protocol                                                                    */
/* -------------------------------------------------------------------------- */

/** One comparison. `a` and `b` must be the same size; both are consumed. */
export interface MetricsRequest {
  /** Correlates the reply. Unique per client. */
  id: number;
  /** The original's pixels. Sent as a copy, transferred in. */
  a: MetricsImage;
  /** The encode's pixels, same dimensions as `a`. Sent as a copy. */
  b: MetricsImage;
  /** Pixel budget before both images are box-averaged down. */
  maxPixels?: number;
}

export interface MetricsSuccess {
  id: number;
  ok: true;
  /** Structural similarity in `[0, 1]`. */
  ssim: number;
  /** Compute time inside the worker, ms. */
  ms: number;
}

export interface MetricsFailure {
  id: number;
  ok: false;
  /** Human-readable reason — mismatched dimensions, empty image, … */
  error: string;
  ms: number;
}

export type MetricsResponse = MetricsSuccess | MetricsFailure;

/* -------------------------------------------------------------------------- */
/* Worker body                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Narrow view of the worker global. Typing it locally sidesteps the
 * `lib: ["DOM", "WebWorker"]` overlap — `self.postMessage` resolves to
 * `Window.postMessage(message, targetOrigin)` otherwise, which is not the
 * signature a worker has.
 */
interface WorkerScope {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<MetricsRequest>) => void,
  ): void;
  postMessage(message: MetricsResponse): void;
}

/**
 * True only inside a worker: `self` exists, `window` does not. Guarding the
 * listener registration keeps this module importable from a vitest node
 * environment (and from the main thread) so {@link handleMetricsRequest} can be
 * tested directly, without a `Worker`.
 */
function workerScope(): WorkerScope | null {
  if (typeof self === 'undefined') return null;
  if (typeof (globalThis as { window?: unknown }).window !== 'undefined') return null;
  return self as unknown as WorkerScope;
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Pure request → response, exported so the protocol is testable without a worker. */
export function handleMetricsRequest(request: MetricsRequest): MetricsResponse {
  const started = now();
  try {
    const pair = downscalePairForMetrics(
      request.a,
      request.b,
      request.maxPixels ?? METRICS_MAX_PIXELS,
    );
    const ssim = computeSsim(pair.a, pair.b);
    return { id: request.id, ok: true, ssim, ms: now() - started };
  } catch (error) {
    return { id: request.id, ok: false, error: describe(error), ms: now() - started };
  }
}

const scope = workerScope();
scope?.addEventListener('message', (event) => {
  scope.postMessage(handleMetricsRequest(event.data));
});
