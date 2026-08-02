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
  SINGLE_THREADED_PARAM,
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
import { drawableToImageData } from './canvas';
import { applyNestedWorkerWorkaround } from './capabilities';
import { rotateTransferable } from './rotate';

/* -------------------------------------------------------------------------- */
/* Threading decision                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Did the bridge ask for the single-threaded builds?
 *
 * It says so by putting `?nothreads=1` on this worker's own URL, which is the
 * only channel available: jSquash picks the threaded or single-threaded build
 * when a codec first initialises and never revisits it, so the choice has to be
 * made before the first `import()` — i.e. in a *fresh* worker, before any
 * message could have arrived. See `bridge.ts` for what makes it ask.
 */
function forcedSingleThreaded(): boolean {
  if (typeof location === 'undefined') return false;
  try {
    return new URLSearchParams(location.search).get(SINGLE_THREADED_PARAM) === '1';
  } catch {
    return false;
  }
}

const singleThreaded = forcedSingleThreaded();

/**
 * Run before any codec is imported. Unforced this only catches Safari 16.0–16.3
 * (threads without nested workers); forced, it is the bridge's retry after a
 * nested worker was refused at runtime.
 */
const workaroundApplied = applyNestedWorkerWorkaround(singleThreaded);

/* -------------------------------------------------------------------------- */
/* Failure reporting                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Narrow view of the worker global, and of the event it hands us. Typing both
 * locally sidesteps the `lib: ["DOM", "WebWorker"]` overlap (same trick as
 * `metrics.worker.ts`) and keeps every field optional, because the interesting
 * failure is precisely the one that fills none of them in.
 */
interface UncaughtErrorEvent {
  readonly type: string;
  readonly message?: string;
  readonly filename?: string;
  readonly lineno?: number;
  readonly colno?: number;
  readonly error?: unknown;
}

interface ErrorReportingScope {
  addEventListener(type: 'error', listener: (event: UncaughtErrorEvent) => void): void;
}

/** `String(event)` is `[object Event]`; say which event, at least. */
function describeThrown(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof Event !== 'undefined' && value instanceof Event) {
    return `a bare "${value.type}" event — the browser refused a script and gave no reason`;
  }
  return String(value);
}

/**
 * Emscripten's pthread bootstrap installs `worker.onerror = e => { throw e }`,
 * so a nested worker the browser refuses to create is rethrown as the raw
 * `Event`. By the time it crosses back to the main thread it has flattened into
 * `"Uncaught [object Event]"`, naming neither the codec nor the script. Log the
 * fields the browser *did* fill in — `filename` is what identifies the failing
 * codec chunk — before that happens.
 *
 * Deliberately does not `preventDefault()`: the event has to keep propagating
 * to the bridge, which is what retries the call on the single-threaded builds.
 */
if (typeof self !== 'undefined') {
  (self as unknown as ErrorReportingScope).addEventListener('error', (event) => {
    console.error('[pinch] codec worker error', {
      type: event.type,
      message: event.message || '(none — the script never ran)',
      script: event.filename || '(unknown)',
      position: `${event.lineno ?? 0}:${event.colno ?? 0}`,
      thrown: describeThrown(event.error),
      // The threading decision this worker started with, so the log says
      // whether this is the first attempt or the bridge's fallback.
      singleThreaded,
      workaroundApplied,
    });
  });
}

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
// libheif 1.22.x (via heic-to) — decode only; HEIC encoding is patent-encumbered
// and has no maintained wasm encoder. heic-to runs libheif in its own nested
// worker (spawned from a blob: URL, so it inherits this worker's COEP) and is
// the only npm package tracking current libheif — 1.19.8, the newest
// libheif-js, mangles Apple's 10-bit 4:4:4 bitstreams (iPhone screenshots).
// `type: 'bitmap'` is forced: heic-to's only other output mode goes through
// `document.createElement('canvas')`, which does not exist in a worker. The
// bitmap→canvas→getImageData round-trip premultiplies alpha, so a rare HEIC
// with real transparency loses some precision in semi-transparent pixels —
// the price of not forking the package.
const loadHeicDecoder = () => loadOnce('dec:heic', () => import('heic-to'));

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
      const { heicTo } = await loadHeicDecoder();
      const bitmap = await heicTo({
        blob: new Blob([buffer], { type: mimeType }),
        type: 'bitmap',
      });
      try {
        return drawableToImageData(bitmap);
      } finally {
        bitmap.close();
      }
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
    // Resize is colour-space-neutral; keep the source's label across the trip.
    payload.colorSpace = data.colorSpace;
    return Comlink.transfer(payload, transferListFor(payload));
  },

  async rotate(data: TransferableImageData, angle: RotateAngle) {
    const payload = rotateTransferable(data, angle);
    payload.colorSpace = data.colorSpace;
    return Comlink.transfer(payload, transferListFor(payload));
  },

  preload(id: WorkerEncoderId) {
    return preloadEncoder(id);
  },
};

Comlink.expose(api);
