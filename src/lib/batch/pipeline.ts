/**
 * One file in, one encoded file out — the unit of work a batch lane performs.
 *
 * Pipeline: sniff → decode → resize → encode → name.
 *
 * The batch pipeline is deliberately *not* the editor's job engine: there is no
 * cache, no debounce and no preprocessor (rotate/crop are per-image decisions
 * that make no sense applied blindly to 200 files). What it shares is the
 * abort discipline — every step calls `assertSignal` on entry and wraps awaits
 * in `abortable`, so a cancel unwinds the lane immediately.
 *
 * wasm work is pushed to the injected {@link WorkerBridgeApi} (one per lane) so
 * N images decode and encode in parallel off the main thread. Canvas paths
 * (`browser-*` encoders, `browser-*` resize kernels, exotic input formats like
 * GIF/BMP/TIFF/SVG) necessarily run on the main thread.
 */

import {
  EXTENSION_BY_MIME,
  MIME_SNIFF_BYTES,
  PDF_NOT_AN_IMAGE_MESSAGE,
  abortable,
  assertSignal,
  getContainOffsets,
  isVectorMimeType,
  isWorkerDecodableMimeType,
  isWorkerResizeMethod,
  mimeTypeFromFilename,
  replaceExtension,
  sniffMimeTypeFromBytes,
  type EncoderId,
  type EncoderRegistry,
  type ImageMimeType,
  type OutputMimeType,
  type ResizeState,
  type SideSettings,
  type WorkerBridgeApi,
  type WorkerResizeOptions,
} from '../contracts';
import { canvasToBlob, context2d, createCanvas, imageDataFrom } from './canvas';
import { basename } from './files';

/* -------------------------------------------------------------------------- */
/* Output typing                                                               */
/* -------------------------------------------------------------------------- */

/**
 * MIME type and extension per encoder.
 *
 * A local mirror of what `EncoderRegistry` reports, so batch mode does not have
 * to pull the codec registry (and its dynamic wasm imports) into its module
 * graph. Pass the real registry through {@link BatchEncodeContext.registry} and
 * it wins.
 */
export const BATCH_ENCODER_OUTPUT: Readonly<
  Record<EncoderId, { mimeType: OutputMimeType; extension: string }>
> = {
  avif: { mimeType: 'image/avif', extension: EXTENSION_BY_MIME['image/avif'] },
  jxl: { mimeType: 'image/jxl', extension: EXTENSION_BY_MIME['image/jxl'] },
  webp: { mimeType: 'image/webp', extension: EXTENSION_BY_MIME['image/webp'] },
  mozjpeg: { mimeType: 'image/jpeg', extension: EXTENSION_BY_MIME['image/jpeg'] },
  oxipng: { mimeType: 'image/png', extension: EXTENSION_BY_MIME['image/png'] },
  qoi: { mimeType: 'image/qoi', extension: EXTENSION_BY_MIME['image/qoi'] },
  'browser-png': { mimeType: 'image/png', extension: EXTENSION_BY_MIME['image/png'] },
  'browser-jpeg': { mimeType: 'image/jpeg', extension: EXTENSION_BY_MIME['image/jpeg'] },
  'browser-webp': { mimeType: 'image/webp', extension: EXTENSION_BY_MIME['image/webp'] },
  identity: { mimeType: '', extension: '' },
};

export function outputTypeFor(
  encoderId: EncoderId,
  registry?: EncoderRegistry,
): { mimeType: OutputMimeType; extension: string } {
  const meta = registry?.[encoderId];
  if (meta) return { mimeType: meta.mimeType, extension: meta.extension };
  return BATCH_ENCODER_OUTPUT[encoderId];
}

/**
 * Filename policy: keep the source basename, swap in the encoder's extension.
 * `identity` keeps the original name untouched.
 */
export function outputNameFor(
  sourceName: string,
  encoderId: EncoderId,
  registry?: EncoderRegistry,
): string {
  const base = basename(sourceName);
  const { extension } = outputTypeFor(encoderId, registry);
  return extension ? replaceExtension(base, extension) : base;
}

/* -------------------------------------------------------------------------- */
/* Encode one file                                                             */
/* -------------------------------------------------------------------------- */

export interface BatchEncodeContext {
  /** The lane's worker bridge. Aborting the lane terminates it. */
  bridge: WorkerBridgeApi;
  /** Real encoder metadata, when the caller has it. */
  registry?: EncoderRegistry | undefined;
}

export type BatchEncodeFn = (
  signal: AbortSignal,
  file: File,
  settings: SideSettings,
  context: BatchEncodeContext,
) => Promise<File>;

export const encodeBatchFile: BatchEncodeFn = async (signal, file, settings, context) => {
  assertSignal(signal);

  const name = outputNameFor(file.name, settings.encoderId, context.registry);

  // `identity` is a pass-through: no decode, no re-encode, no memory spike.
  if (settings.encoderId === 'identity') {
    if (file.name === name) return file;
    return new File([file], name, { type: file.type, lastModified: file.lastModified });
  }

  const decoded = await decodeToImageData(signal, file, context.bridge);
  const processed = await resizeImageData(
    signal,
    decoded,
    settings.processorState.resize,
    context.bridge,
  );
  const { blob, mimeType } = await encodeImageData(signal, processed, settings, context);

  return new File([blob], name, {
    type: mimeType || blob.type,
    lastModified: file.lastModified,
  });
};

/* -------------------------------------------------------------------------- */
/* Decode                                                                      */
/* -------------------------------------------------------------------------- */

export async function sniffFileMimeType(
  signal: AbortSignal,
  file: File,
): Promise<ImageMimeType | ''> {
  assertSignal(signal);
  const head = new Uint8Array(
    await abortable(signal, file.slice(0, MIME_SNIFF_BYTES).arrayBuffer()),
  );
  const sniffed = sniffMimeTypeFromBytes(head);

  if (sniffed === 'application/pdf') {
    throw new Error(PDF_NOT_AN_IMAGE_MESSAGE);
  }
  if (sniffed !== '') return sniffed;

  const byName = mimeTypeFromFilename(file.name);
  if (byName !== '') return byName;
  return file.type.startsWith('image/') ? (file.type as ImageMimeType) : '';
}

/**
 * Decode to pixels, preferring the worker.
 *
 * Worker-first matters for throughput: the main thread stays free to paint the
 * grid while N lanes decode in parallel. The browser fallback covers formats
 * wasm does not ship (GIF/BMP/TIFF) and rescues codecs the worker rejects —
 * Chrome decodes AVIF natively, for instance.
 */
export async function decodeToImageData(
  signal: AbortSignal,
  file: File,
  bridge: WorkerBridgeApi,
): Promise<ImageData> {
  const mimeType = await sniffFileMimeType(signal, file);
  assertSignal(signal);

  if (isVectorMimeType(mimeType)) return rasterizeSvg(signal, file);

  if (isWorkerDecodableMimeType(mimeType)) {
    try {
      const buffer = await abortable(signal, file.arrayBuffer());
      return await bridge.decode(signal, mimeType, buffer);
    } catch (error) {
      assertSignal(signal);
      return decodeWithBrowser(signal, file).catch(() => {
        throw error;
      });
    }
  }

  return decodeWithBrowser(signal, file);
}

async function decodeWithBrowser(signal: AbortSignal, file: File): Promise<ImageData> {
  assertSignal(signal);
  if (typeof createImageBitmap !== 'function') {
    throw new Error('This browser cannot decode that image format');
  }

  const bitmap = await abortable(signal, createImageBitmap(file));
  try {
    assertSignal(signal);
    return imageDataFrom(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/**
 * SVG has no intrinsic pixel size until it is laid out, so it takes the
 * `<img>` route rather than `createImageBitmap` (which Safari refuses for SVG).
 */
async function rasterizeSvg(signal: AbortSignal, file: File): Promise<ImageData> {
  assertSignal(signal);
  if (typeof document === 'undefined' || typeof Image !== 'function') {
    throw new Error('SVG rasterisation needs a document');
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'sync';
    await abortable(
      signal,
      new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('Could not parse that SVG'));
        image.src = url;
      }),
    );

    const width = image.naturalWidth || image.width || 300;
    const height = image.naturalHeight || image.height || 150;
    return imageDataFrom(image, width, height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* -------------------------------------------------------------------------- */
/* Resize                                                                      */
/* -------------------------------------------------------------------------- */

export async function resizeImageData(
  signal: AbortSignal,
  data: ImageData,
  resize: ResizeState,
  bridge: WorkerBridgeApi,
): Promise<ImageData> {
  assertSignal(signal);
  if (!resize.enabled) return data;

  const width = Math.max(1, Math.round(resize.width));
  const height = Math.max(1, Math.round(resize.height));
  if (width === data.width && height === data.height) return data;

  if (isWorkerResizeMethod(resize.method)) {
    const options: WorkerResizeOptions = {
      width,
      height,
      method: resize.method,
      premultiply: resize.premultiply,
      linearRGB: resize.linearRGB,
      fitMethod: resize.fitMethod,
    };
    return bridge.resize(signal, data, options);
  }

  return resizeWithCanvas(data, width, height, resize);
}

/** `browser-high` / `browser-pixelated` — canvas-only, main thread by definition. */
function resizeWithCanvas(
  data: ImageData,
  width: number,
  height: number,
  resize: ResizeState,
): ImageData {
  const source = createCanvas(data.width, data.height);
  context2d(source).putImageData(data, 0, 0);

  const target = createCanvas(width, height);
  const context = context2d(target, true);
  const pixelated = resize.method === 'browser-pixelated';
  context.imageSmoothingEnabled = !pixelated;
  if (!pixelated) context.imageSmoothingQuality = 'high';

  const { sx, sy, sw, sh } =
    resize.fitMethod === 'contain'
      ? getContainOffsets(data.width, data.height, width, height)
      : { sx: 0, sy: 0, sw: data.width, sh: data.height };

  context.drawImage(source as CanvasImageSource, sx, sy, sw, sh, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

/* -------------------------------------------------------------------------- */
/* Encode                                                                      */
/* -------------------------------------------------------------------------- */

export async function encodeImageData(
  signal: AbortSignal,
  data: ImageData,
  settings: SideSettings,
  context: BatchEncodeContext,
): Promise<{ blob: Blob; mimeType: OutputMimeType }> {
  assertSignal(signal);
  const { bridge } = context;
  const { mimeType } = outputTypeFor(settings.encoderId, context.registry);

  // One `case` per encoder rather than a grouped case: only an exact literal
  // narrows `encoderOptions` to the matching option type, which is what makes
  // `bridge.encode<K>` type-safe without a cast.
  switch (settings.encoderId) {
    case 'avif': {
      const buffer = await bridge.encode(signal, 'avif', data, settings.encoderOptions);
      return { blob: new Blob([buffer], { type: mimeType }), mimeType };
    }
    case 'jxl': {
      const buffer = await bridge.encode(signal, 'jxl', data, settings.encoderOptions);
      return { blob: new Blob([buffer], { type: mimeType }), mimeType };
    }
    case 'webp': {
      const buffer = await bridge.encode(signal, 'webp', data, settings.encoderOptions);
      return { blob: new Blob([buffer], { type: mimeType }), mimeType };
    }
    case 'mozjpeg': {
      const buffer = await bridge.encode(signal, 'mozjpeg', data, settings.encoderOptions);
      return { blob: new Blob([buffer], { type: mimeType }), mimeType };
    }
    case 'oxipng': {
      const buffer = await bridge.encode(signal, 'oxipng', data, settings.encoderOptions);
      return { blob: new Blob([buffer], { type: mimeType }), mimeType };
    }
    case 'qoi': {
      const buffer = await bridge.encode(signal, 'qoi', data, settings.encoderOptions);
      return { blob: new Blob([buffer], { type: mimeType }), mimeType };
    }
    case 'browser-png':
      return { blob: await encodeWithCanvas(data, 'image/png'), mimeType };
    case 'browser-jpeg':
      return {
        blob: await encodeWithCanvas(data, 'image/jpeg', settings.encoderOptions.quality),
        mimeType,
      };
    case 'browser-webp':
      return {
        blob: await encodeWithCanvas(data, 'image/webp', settings.encoderOptions.quality),
        mimeType,
      };
    case 'identity':
      throw new Error('identity is a pass-through and must be handled before encoding');
  }
}

async function encodeWithCanvas(
  data: ImageData,
  type: string,
  quality?: number,
): Promise<Blob> {
  const canvas = createCanvas(data.width, data.height);
  context2d(canvas).putImageData(data, 0, 0);
  return canvasToBlob(canvas, type, quality);
}
