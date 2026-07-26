/**
 * Comlink worker protocol.
 *
 * ## Transfer discipline
 * `ImageData` survives structured clone but its backing buffer is copied, which
 * is expensive for large images. Every method here therefore speaks
 * {@link TransferableImageData} — a plain `{ data, width, height }` bag whose
 * `data.buffer` can be handed to Comlink's transfer list:
 *
 * ```ts
 * const payload = toTransferable(imageData);
 * const out = await api.resize(Comlink.transfer(payload, transferListFor(payload)), opts);
 * ```
 *
 * Transferring **detaches** the buffer on the sending side. Never transfer
 * pixels you still need locally (e.g. the cached source image) — clone first,
 * or omit the transfer list and pay for the copy.
 *
 * ## Abort semantics
 * wasm work cannot be interrupted once it enters the module. There is no
 * `cancel()` on this interface by design: **abort == terminate**. The bridge
 * calls `worker.terminate()`, drops the Comlink proxy, rejects all in-flight
 * calls with an `AbortError` `DOMException`, and lazily spawns a fresh worker on
 * the next request. Because a terminate throws away the warm wasm instances,
 * each editor side owns its own worker so aborting one side never stalls the
 * other.
 *
 * Dependency-free: types and tiny pure helpers only.
 */

import type { EncoderOptionsMap, WorkerEncoderId } from './codecs';
import type { RotateAngle, WorkerResizeOptions } from './processing';

/* -------------------------------------------------------------------------- */
/* Transferable image payload                                                  */
/* -------------------------------------------------------------------------- */

/** Structured-clone friendly stand-in for `ImageData`. */
export interface TransferableImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /**
   * Colour space of the pixels. Carried across the worker boundary so a
   * wide-gamut (`display-p3`) image survives a colour-space-neutral resize or
   * rotate instead of being silently relabelled sRGB on the way back. Absent
   * means sRGB.
   */
  colorSpace?: PredefinedColorSpace;
}

/** Wrap an `ImageData` without copying pixels. */
export function toTransferable(image: ImageData): TransferableImageData {
  return {
    data: image.data,
    width: image.width,
    height: image.height,
    colorSpace: image.colorSpace,
  };
}

/** Rebuild an `ImageData` around the payload's buffer, without copying pixels. */
export function fromTransferable(payload: TransferableImageData): ImageData {
  // Cast through a local ctor type: lib.dom's ImageData signature varies across
  // TS versions on the Uint8ClampedArray buffer generic, and this keeps the
  // contract compiling on all of them.
  const Ctor = ImageData as unknown as new (
    data: Uint8ClampedArray,
    width: number,
    height: number,
    settings?: ImageDataSettings,
  ) => ImageData;
  return payload.colorSpace
    ? new Ctor(payload.data, payload.width, payload.height, { colorSpace: payload.colorSpace })
    : new Ctor(payload.data, payload.width, payload.height);
}

/** Transfer list for a payload — pass to `Comlink.transfer`. */
export function transferListFor(payload: TransferableImageData): Transferable[] {
  return [payload.data.buffer as ArrayBuffer];
}

/** Deep copy, for when you must keep the pixels after transferring. */
export function cloneTransferable(payload: TransferableImageData): TransferableImageData {
  return {
    data: new Uint8ClampedArray(payload.data),
    width: payload.width,
    height: payload.height,
    colorSpace: payload.colorSpace,
  };
}

/* -------------------------------------------------------------------------- */
/* Worker API                                                                  */
/* -------------------------------------------------------------------------- */

/** MIME types the worker can decode with wasm when the browser cannot. */
export type WorkerDecodableMimeType =
  | 'image/avif'
  | 'image/jxl'
  | 'image/webp'
  | 'image/jpeg'
  | 'image/png'
  | 'image/qoi'
  | 'image/heic'
  | 'image/heif';

export function isWorkerDecodableMimeType(value: string): value is WorkerDecodableMimeType {
  return (
    value === 'image/avif' ||
    value === 'image/jxl' ||
    value === 'image/webp' ||
    value === 'image/jpeg' ||
    value === 'image/png' ||
    value === 'image/qoi' ||
    value === 'image/heic' ||
    value === 'image/heif'
  );
}

/**
 * The surface exposed with `Comlink.expose(api)` inside `*.worker.ts`.
 *
 * Consumers hold a `Comlink.Remote<WorkerApi>`, so every method is already
 * promise-returning on the caller's side. Arguments and returns are limited to
 * structured-cloneable values; no callbacks, no `AbortSignal` (see the module
 * doc for why abort is terminate-only).
 */
export interface WorkerApi {
  /**
   * Decode compressed bytes to pixels.
   * @param mimeType which wasm decoder to use — sniff before calling.
   * @param buffer the compressed file bytes; transfer it, the worker consumes it.
   */
  decode(
    mimeType: WorkerDecodableMimeType,
    buffer: ArrayBuffer,
  ): Promise<TransferableImageData>;

  /**
   * Encode pixels with a wasm codec.
   * @returns the compressed bytes; the worker transfers them back.
   */
  encode<K extends WorkerEncoderId>(
    id: K,
    data: TransferableImageData,
    options: EncoderOptionsMap[K],
  ): Promise<ArrayBuffer>;

  /** Resample with `@jsquash/resize`. `browser-*` methods are not accepted here. */
  resize(
    data: TransferableImageData,
    options: WorkerResizeOptions,
  ): Promise<TransferableImageData>;

  /** Rotate clockwise by a multiple of 90°. `0` is a cheap pass-through. */
  rotate(data: TransferableImageData, angle: RotateAngle): Promise<TransferableImageData>;

  /**
   * Warm a codec's wasm module ahead of first use (e.g. on encoder select).
   * Best-effort: failures must resolve, not reject.
   */
  preload?(id: WorkerEncoderId): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Main-thread bridge                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Main-thread wrapper around one worker. Mirrors {@link WorkerApi} but takes an
 * `AbortSignal` first on every call, and translates abort into terminate.
 *
 * It also owns the `ImageData` ⇄ {@link TransferableImageData} conversion so
 * callers (job engine, batch queue) only ever deal in `ImageData`.
 *
 * Construct with:
 * `new Worker(new URL('./codec.worker.ts', import.meta.url), { type: 'module' })`
 */
export interface WorkerBridgeApi {
  decode(
    signal: AbortSignal,
    mimeType: WorkerDecodableMimeType,
    buffer: ArrayBuffer,
  ): Promise<ImageData>;

  encode<K extends WorkerEncoderId>(
    signal: AbortSignal,
    id: K,
    data: ImageData,
    options: EncoderOptionsMap[K],
  ): Promise<ArrayBuffer>;

  resize(
    signal: AbortSignal,
    data: ImageData,
    options: WorkerResizeOptions,
  ): Promise<ImageData>;

  rotate(signal: AbortSignal, data: ImageData, angle: RotateAngle): Promise<ImageData>;

  /** Fire-and-forget wasm warm-up. Never rejects. */
  preload(id: WorkerEncoderId): void;

  /** Terminate the worker and reject everything in flight. Safe to call twice. */
  terminate(): void;
}

/** Factory so tests can inject a fake bridge. */
export type CreateWorkerBridge = () => WorkerBridgeApi;
