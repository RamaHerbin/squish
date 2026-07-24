/**
 * The codec worker: every wasm call squish makes happens in here.
 *
 * Exposes {@link WorkerApi} over Comlink. One instance per editor side, spawned
 * and owned by `bridge.ts` — see that file for the abort-equals-terminate
 * story.
 *
 * ## Laziness
 * Nothing is imported until it is asked for. `import('@jsquash/avif/encode')`
 * only runs the first time somebody encodes an AVIF, and the resulting promise
 * is memoised, so the wasm module is instantiated once per worker and stays
 * warm for the rest of its life. jSquash itself then picks the SIMD/threaded
 * build appropriate for the browser.
 *
 * ## Transfers
 * Pixels arrive as {@link TransferableImageData} and leave the same way, always
 * with a transfer list — a worker's copy of a buffer is disposable by
 * definition, so there is never a reason to pay for the clone on the way out.
 */

import * as Comlink from 'comlink';

import {
  fromTransferable,
  toTransferable,
  transferListFor,
  type AnyEncoderOptions,
  type AvifEncodeOptions,
  type JxlEncodeOptions,
  type MozJpegEncodeOptions,
  type OxiPngEncodeOptions,
  type RotateAngle,
  type TransferableImageData,
  type WebpEncodeOptions,
  type WorkerApi,
  type WorkerDecodableMimeType,
  type WorkerEncoderId,
  type WorkerResizeOptions,
} from '../contracts';
import { applyNestedWorkerWorkaround } from './capabilities';
import { rotateTransferable } from './rotate';

/**
 * Safari 16.0–16.3 reports wasm threads support but cannot spawn the nested
 * workers emscripten's pthread pool needs. Run before any codec is imported —
 * jSquash decides single- vs multi-threaded at init time and never revisits it.
 */
applyNestedWorkerWorkaround();

/* -------------------------------------------------------------------------- */
/* Module cache                                                                */
/* -------------------------------------------------------------------------- */

const moduleCache = new Map<string, Promise<unknown>>();

/** Memoised dynamic import. A rejected load is evicted so it can be retried. */
function loadOnce<T>(key: string, load: () => Promise<T>): Promise<T> {
  const cached = moduleCache.get(key) as Promise<T> | undefined;
  if (cached) return cached;

  const pending = load().catch((error: unknown) => {
    moduleCache.delete(key);
    throw error;
  });
  moduleCache.set(key, pending);
  return pending;
}

const loadAvifEncoder = () => loadOnce('enc:avif', () => import('@jsquash/avif/encode'));
const loadJxlEncoder = () => loadOnce('enc:jxl', () => import('@jsquash/jxl/encode'));
const loadWebpEncoder = () => loadOnce('enc:webp', () => import('@jsquash/webp/encode'));
const loadJpegEncoder = () => loadOnce('enc:mozjpeg', () => import('@jsquash/jpeg/encode'));
const loadOxiPng = () => loadOnce('enc:oxipng', () => import('@jsquash/oxipng/optimise'));
const loadQoiEncoder = () => loadOnce('enc:qoi', () => import('@jsquash/qoi/encode'));

const loadAvifDecoder = () => loadOnce('dec:avif', () => import('@jsquash/avif/decode'));
const loadJxlDecoder = () => loadOnce('dec:jxl', () => import('@jsquash/jxl/decode'));
const loadWebpDecoder = () => loadOnce('dec:webp', () => import('@jsquash/webp/decode'));
const loadJpegDecoder = () => loadOnce('dec:jpeg', () => import('@jsquash/jpeg/decode'));
const loadPngDecoder = () => loadOnce('dec:png', () => import('@jsquash/png/decode'));
const loadQoiDecoder = () => loadOnce('dec:qoi', () => import('@jsquash/qoi/decode'));
// libheif (via heic-decode) — decode only; HEIC encoding is patent-encumbered
// and has no maintained wasm encoder.
const loadHeicDecoder = () => loadOnce('dec:heic', () => import('heic-decode'));

const loadResizer = () => loadOnce('resize', () => import('@jsquash/resize'));

/* -------------------------------------------------------------------------- */
/* Encoding                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `options` cannot be narrowed alongside `id` here: TypeScript does not
 * correlate a generic discriminant with a generic indexed access, so each
 * branch asserts the shape the registry guarantees for that id.
 */
async function encodeImage(
  id: WorkerEncoderId,
  image: ImageData,
  options: AnyEncoderOptions,
): Promise<ArrayBuffer> {
  switch (id) {
    case 'avif': {
      const { default: encode } = await loadAvifEncoder();
      return encode(image, options as AvifEncodeOptions);
    }
    case 'jxl': {
      const { default: encode } = await loadJxlEncoder();
      return encode(image, options as JxlEncodeOptions);
    }
    case 'webp': {
      const { default: encode } = await loadWebpEncoder();
      return encode(image, options as WebpEncodeOptions);
    }
    case 'mozjpeg': {
      const { default: encode } = await loadJpegEncoder();
      return encode(image, options as MozJpegEncodeOptions);
    }
    case 'oxipng': {
      const { default: optimise } = await loadOxiPng();
      return optimise(image, options as OxiPngEncodeOptions);
    }
    case 'qoi': {
      const { default: encode } = await loadQoiEncoder();
      return encode(image);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Decoding                                                                    */
/* -------------------------------------------------------------------------- */

async function decodeImage(
  mimeType: WorkerDecodableMimeType,
  buffer: ArrayBuffer,
): Promise<ImageData> {
  switch (mimeType) {
    case 'image/avif': {
      const { default: decode } = await loadAvifDecoder();
      const image = await decode(buffer);
      if (!image) throw new Error('AVIF decoding failed');
      return image;
    }
    case 'image/jxl': {
      const { default: decode } = await loadJxlDecoder();
      return decode(buffer);
    }
    case 'image/webp': {
      const { default: decode } = await loadWebpDecoder();
      return decode(buffer);
    }
    case 'image/jpeg': {
      const { default: decode } = await loadJpegDecoder();
      return decode(buffer);
    }
    case 'image/png': {
      const { default: decode } = await loadPngDecoder();
      return decode(buffer);
    }
    case 'image/qoi': {
      const { default: decode } = await loadQoiDecoder();
      return decode(buffer);
    }
    case 'image/heic':
    case 'image/heif': {
      const { default: decode } = await loadHeicDecoder();
      const { width, height, data } = await decode({ buffer: new Uint8Array(buffer) });
      return new ImageData(new Uint8ClampedArray(data), width, height);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Warm-up                                                                     */
/* -------------------------------------------------------------------------- */

/** Instantiate a codec's wasm without encoding anything. Never rejects. */
async function preloadEncoder(id: WorkerEncoderId): Promise<void> {
  try {
    switch (id) {
      case 'avif':
        await (await loadAvifEncoder()).init();
        return;
      case 'jxl':
        await (await loadJxlEncoder()).init();
        return;
      case 'webp':
        await (await loadWebpEncoder()).init();
        return;
      case 'mozjpeg':
        await (await loadJpegEncoder()).init();
        return;
      case 'oxipng':
        await (await loadOxiPng()).init();
        return;
      case 'qoi':
        await (await loadQoiEncoder()).init();
        return;
    }
  } catch {
    // Best effort: a failed warm-up must not surface as a job error. The real
    // encode call will report the problem with proper context.
  }
}

/* -------------------------------------------------------------------------- */
/* Exposed API                                                                 */
/* -------------------------------------------------------------------------- */

/** {@link WorkerApi} with `preload` promoted to required — this worker has it. */
export type CodecWorkerApi = Required<WorkerApi>;

const api: CodecWorkerApi = {
  async decode(mimeType, buffer) {
    const payload = toTransferable(await decodeImage(mimeType, buffer));
    return Comlink.transfer(payload, transferListFor(payload));
  },

  async encode(id, data, options) {
    const buffer = await encodeImage(
      id,
      fromTransferable(data),
      options as AnyEncoderOptions,
    );
    return Comlink.transfer(buffer, [buffer]);
  },

  async resize(data: TransferableImageData, options: WorkerResizeOptions) {
    const { default: resize } = await loadResizer();
    const payload = toTransferable(await resize(fromTransferable(data), options));
    return Comlink.transfer(payload, transferListFor(payload));
  },

  async rotate(data: TransferableImageData, angle: RotateAngle) {
    const payload = rotateTransferable(data, angle);
    return Comlink.transfer(payload, transferListFor(payload));
  },

  preload(id: WorkerEncoderId) {
    return preloadEncoder(id);
  },
};

Comlink.expose(api);
