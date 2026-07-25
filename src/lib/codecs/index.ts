/**
 * The codec layer: everything that turns bytes into pixels and back.
 *
 * ```ts
 * import { createWorkerBridge, decodeToSourceImage, ENCODER_REGISTRY } from '../codecs';
 * ```
 *
 * Import the barrel for metadata and the decode chain. `codec.worker.ts` is
 * deliberately **not** re-exported — it is an entry point, spawned by
 * `bridge.ts`, and importing it from the main thread would evaluate
 * `Comlink.expose` in the wrong realm.
 *
 * Nothing in this barrel spawns a worker or loads wasm at import time. The
 * first `bridge` call spawns; the first `encode`/`decode` of a given format
 * pulls that codec's chunk inside the worker.
 */

export { HDR_SCAN_BYTES, detectHdr, hdrLabel, type HdrInfo, type HdrKind } from './hdr';
export {
  applyNestedWorkerWorkaround,
  canDecodeImageType,
  canEncodeImageType,
  getCapabilities,
  hasCreateImageBitmap,
  hasDocument,
  hasImageDecoder,
  hasOffscreenCanvas,
  isCrossOriginIsolated,
  isSafari,
  isWorkerScope,
  resetCapabilityCaches,
  supportsNestedWorkers,
  supportsWasmSimd,
  supportsWasmThreads,
  type CapabilityReport,
} from './capabilities';

export {
  blobToImg,
  builtinResize,
  canvasEncode,
  createCanvas,
  drawDataToCanvas,
  drawableToImageData,
  loadImageElement,
  type BuiltinResizeMethod,
  type DrawableToImageDataOptions,
} from './canvas';

export { rotateTransferable, rotationSwapsAxes } from './rotate';

export {
  ENCODER_METAS,
  ENCODER_REGISTRY,
  createEncoderLoader,
  encoderExtension,
  encoderLabel,
  encoderMimeType,
  getEncoderMeta,
  loadEncoderModule,
  outputFileName,
  resetSharedEncoderLoader,
} from './registry';

export {
  BROWSER_ENCODER_MIME,
  browserEncode,
  createBrowserEncoderModule,
  identityEncoderModule,
  isBrowserEncoderId,
} from './browser-encoders';

export {
  createWorkerEncoderModule,
  preloadWorkerEncoder,
  wasmEncoderFeatureTest,
} from './worker-encoders';

export {
  WORKER_IDLE_TIMEOUT_MS,
  createDefaultWorkerBridge,
  createWorkerBridge,
  disposeSharedWorkerBridge,
  getSharedWorkerBridge,
  type WorkerBridgeOptions,
} from './bridge';

export {
  builtinDecode,
  decodeBlob,
  decodeFile,
  decodeToSourceImage,
  isImageMimeType,
  normaliseSvg,
  rasterizeSvg,
  resolveMimeType,
  sniffMimeType,
  type DecodeImageOptions,
} from './decode';
