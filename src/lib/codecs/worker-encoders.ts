/**
 * Main-thread wrappers for the six wasm codecs.
 *
 * There is deliberately no wasm in this file. Each module is a ~5-line adapter
 * that forwards to a {@link WorkerBridgeApi}; the codec payload is dynamically
 * imported inside `codec.worker.ts`, which is where laziness actually saves
 * bytes. Loaded through `registry.ts`'s `import('./worker-encoders')`.
 */

import {
  type EncoderMeta,
  type EncoderModule,
  type WorkerBridgeApi,
  type WorkerEncoderId,
} from '../contracts';
import { ENCODER_REGISTRY } from './registry';

let wasmSupport: Promise<boolean> | undefined;

/**
 * Every wasm codec has the same requirement: a WebAssembly runtime.
 *
 * jSquash picks its own SIMD/threaded build per codec at init time and falls
 * back to the baseline build, so there is nothing finer-grained worth probing
 * here — a browser either runs all six or none.
 */
export function wasmEncoderFeatureTest(): Promise<boolean> {
  if (!wasmSupport) {
    wasmSupport = Promise.resolve(
      typeof WebAssembly !== 'undefined' && typeof WebAssembly.validate === 'function',
    );
  }
  return wasmSupport;
}

/** Adapter turning one wasm encoder id into an {@link EncoderModule}. */
export function createWorkerEncoderModule<K extends WorkerEncoderId>(
  id: K,
  bridge: WorkerBridgeApi,
): EncoderModule<K> {
  const meta: EncoderMeta<K> = ENCODER_REGISTRY[id];
  return {
    meta,
    encode: (signal, data, options) => bridge.encode(signal, id, data, options),
    featureTest: wasmEncoderFeatureTest,
  };
}

/** Warm a codec's wasm ahead of first use. Fire and forget; never rejects. */
export function preloadWorkerEncoder(id: WorkerEncoderId, bridge: WorkerBridgeApi): void {
  bridge.preload(id);
}
