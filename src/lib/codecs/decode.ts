/**
 * The decode chain: bytes on disk → RGBA pixels.
 *
 * ## Order of attack
 * 1. **Sniff.** Magic numbers first, because `File.type` is whatever the OS
 *    guessed from the extension and is wrong often enough to matter (and is
 *    empty for anything dragged out of a zip).
 * 2. **Native decode.** WebCodecs `ImageDecoder` when the browser has it —
 *    it works off the main thread, in a worker, and hands back a `VideoFrame`
 *    with no `<img>` lifecycle to babysit. Otherwise `createImageBitmap`,
 *    otherwise an `<img>` element.
 * 3. **wasm fallback.** For AVIF/JXL/WebP/QOI/JPEG/PNG the worker can decode
 *    what the browser refuses to. This is the whole reason a Firefox user can
 *    open a JXL at all.
 *
 * If the preferred path throws, the other one is tried before giving up: a
 * browser advertising AVIF support can still choke on an exotic AVIF, and the
 * wasm decoder usually copes.
 *
 * SVG takes an entirely separate route — there is no bitmap to decode, only
 * markup to rasterise, and the markup is kept so the image can be re-rasterised
 * crisply at any resize target.
 */

import {
  EXTENSION_BY_MIME,
  MIME_SNIFF_BYTES,
  abortable,
  assertSignal,
  isAbortError,
  isVectorMimeType,
  isWorkerDecodableMimeType,
  mimeTypeFromFilename,
  sniffMimeTypeFromBytes,
  type DecodeResult,
  type ImageMimeType,
  type MimeSniffResult,
  type OutputMimeType,
  type SourceImage,
  type WorkerBridgeApi,
  type WorkerDecodableMimeType,
} from '../contracts';
import {
  canDecodeImageType,
  hasCreateImageBitmap,
  hasDocument,
  hasImageDecoder,
} from './capabilities';
import {
  blobToImg,
  drawableToImageData,
  supportsColorSpace,
  type DrawableToImageDataOptions,
} from './canvas';
import { HDR_SCAN_BYTES, detectHdr, preferredColorSpace } from './hdr';

/* -------------------------------------------------------------------------- */
/* Sniffing                                                                    */
/* -------------------------------------------------------------------------- */

/** Is this string one of the image MIME types squish recognises? */
export function isImageMimeType(value: string): value is ImageMimeType {
  return Object.prototype.hasOwnProperty.call(EXTENSION_BY_MIME, value);
}

/**
 * Decide what a file is, from its bytes first and its labels second.
 *
 * Pure — hand it the header, the declared type and the name, and it will tell
 * you which of the three it believed. Split out from {@link sniffMimeType} so
 * the decision table is unit-testable without a `Blob`.
 */
export function resolveMimeType(
  header: Uint8Array,
  declaredType = '',
  filename = '',
): MimeSniffResult {
  const sniffed = sniffMimeTypeFromBytes(header);

  if (sniffed === 'application/pdf') {
    return { mimeType: '', source: 'magic-number', unsupported: 'application/pdf' };
  }
  if (sniffed) return { mimeType: sniffed, source: 'magic-number' };

  const declared = declaredType.split(';')[0]?.trim() ?? '';
  if (isImageMimeType(declared)) return { mimeType: declared, source: 'file-type' };

  const fromName = mimeTypeFromFilename(filename);
  if (fromName) return { mimeType: fromName, source: 'extension' };

  return { mimeType: '', source: 'unknown' };
}

/** {@link resolveMimeType} for a `Blob`; reads only the first few bytes. */
export async function sniffMimeType(blob: Blob, filename = ''): Promise<MimeSniffResult> {
  const header = new Uint8Array(await blob.slice(0, MIME_SNIFF_BYTES).arrayBuffer());
  const name =
    filename || (typeof File !== 'undefined' && blob instanceof File ? blob.name : '');
  return resolveMimeType(header, blob.type, name);
}

/* -------------------------------------------------------------------------- */
/* Native decoding                                                             */
/* -------------------------------------------------------------------------- */

async function decodeWithImageDecoder(
  blob: Blob,
  mimeType: string,
  colorSpace?: PredefinedColorSpace,
): Promise<ImageData> {
  const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: mimeType });
  try {
    const { image } = await decoder.decode();
    try {
      return drawableToImageData(image, { colorSpace });
    } finally {
      image.close();
    }
  } finally {
    decoder.close();
  }
}

async function decodeWithImageBitmap(
  blob: Blob,
  colorSpace?: PredefinedColorSpace,
): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob);
  try {
    return drawableToImageData(bitmap, { colorSpace });
  } finally {
    bitmap.close();
  }
}

/**
 * Decode with whatever the browser provides, best option first.
 *
 * @param mimeType the sniffed type; required by `ImageDecoder`, ignored by the
 *   other two paths (which re-sniff internally).
 * @param colorSpace read pixels back in this space — `display-p3` for a
 *   wide-gamut source so the browser doesn't clip it to sRGB. Defaults to sRGB.
 */
export async function builtinDecode(
  signal: AbortSignal,
  blob: Blob,
  mimeType: OutputMimeType = '',
  colorSpace?: PredefinedColorSpace,
): Promise<ImageData> {
  assertSignal(signal);
  let lastError: unknown;

  if (mimeType && hasImageDecoder()) {
    try {
      return await abortable(signal, decodeWithImageDecoder(blob, mimeType, colorSpace));
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = error;
    }
  }

  if (hasCreateImageBitmap()) {
    try {
      return await abortable(signal, decodeWithImageBitmap(blob, colorSpace));
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = error;
    }
  }

  if (hasDocument()) {
    assertSignal(signal);
    const img = await abortable(signal, blobToImg(blob));
    return drawableToImageData(img, { colorSpace });
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('No built-in image decoder is available');
}

/* -------------------------------------------------------------------------- */
/* SVG                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Return SVG markup that is safe to draw to a canvas.
 *
 * Firefox refuses to draw an SVG with no intrinsic size and Chrome draws it
 * wrong, so a missing `width`/`height` pair is filled in from the `viewBox`.
 * The result is kept as text on {@link SourceImage.vector} — that is what makes
 * "resize a vector" mean re-rasterising rather than upscaling pixels.
 */
export async function normaliseSvg(signal: AbortSignal, blob: Blob): Promise<string> {
  assertSignal(signal);
  if (!hasDocument()) throw new Error('SVG decoding requires a document');

  const text = await abortable(signal, blob.text());
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');

  if (doc.querySelector('parsererror')) throw new Error('This SVG could not be parsed');

  const svg = doc.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== 'svg') {
    throw new Error('This file is not an SVG document');
  }

  if (svg.hasAttribute('width') && svg.hasAttribute('height')) return text;

  const viewBox = svg.getAttribute('viewBox');
  if (viewBox === null) throw new Error('This SVG has neither width/height nor a viewBox');

  const parts = viewBox.trim().split(/[\s,]+/);
  const width = parts[2];
  const height = parts[3];
  if (!width || !height) throw new Error('This SVG has an unreadable viewBox');

  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  return new XMLSerializer().serializeToString(doc);
}

/**
 * Rasterise SVG markup at a chosen size.
 *
 * Pass no options for the intrinsic size (the decode path), or a target
 * width/height to re-render the vector crisply at that size (the resize path).
 */
export async function rasterizeSvg(
  svgText: string,
  options: DrawableToImageDataOptions = {},
): Promise<ImageData> {
  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const img = await blobToImg(blob);
  return drawableToImageData(img, options);
}

/* -------------------------------------------------------------------------- */
/* The chain                                                                   */
/* -------------------------------------------------------------------------- */

export interface DecodeImageOptions {
  /**
   * Worker to fall back to for wasm decoding. Defaults to the shared bridge,
   * imported lazily so a purely native decode never spawns a worker.
   */
  bridge?: WorkerBridgeApi;
}

async function resolveBridge(options: DecodeImageOptions): Promise<WorkerBridgeApi> {
  if (options.bridge) return options.bridge;
  const { getSharedWorkerBridge } = await import('./bridge');
  return getSharedWorkerBridge();
}

function decodeFailure(mimeType: OutputMimeType, cause: unknown): Error {
  const what = mimeType || 'this file';
  const error = new Error(`Couldn't decode ${what}`);
  if (cause !== undefined) error.cause = cause;
  return error;
}

/** Decode a blob to pixels, with its sniffed type and provenance. */
export async function decodeBlob(
  signal: AbortSignal,
  blob: Blob,
  filename = '',
  options: DecodeImageOptions = {},
): Promise<DecodeResult> {
  assertSignal(signal);

  const sniffed = await abortable(signal, sniffMimeType(blob, filename));

  if (sniffed.unsupported === 'application/pdf') {
    throw new Error('PDFs are not images — export a page as PNG or JPEG first');
  }

  const mimeType = sniffed.mimeType;

  if (isVectorMimeType(mimeType)) {
    const svgText = await normaliseSvg(signal, blob);
    assertSignal(signal);
    const data = await abortable(signal, rasterizeSvg(svgText));
    return { data, mimeType, vector: { svgText }, usedBuiltinDecoder: true };
  }

  // HDR and gamut are both read from the header bytes, independently of which
  // decoder ends up producing pixels. Gamut picks the readback colour space so
  // a wide-gamut source is preserved instead of clipped to sRGB.
  const header = new Uint8Array(
    await abortable(signal, blob.slice(0, HDR_SCAN_BYTES).arrayBuffer()),
  );
  const hdr = detectHdr(header, mimeType);
  // Widen only when the source is wide-gamut AND this browser can round-trip P3;
  // otherwise stay sRGB (the pre-existing behaviour) rather than risk a throw.
  const wide = preferredColorSpace(header, mimeType);
  const colorSpace: PredefinedColorSpace =
    wide === 'display-p3' && supportsColorSpace('display-p3') ? 'display-p3' : 'srgb';

  // Captured as a separate binding so the narrowed type survives into the
  // closure below.
  const wasmMimeType: WorkerDecodableMimeType | undefined = isWorkerDecodableMimeType(
    mimeType,
  )
    ? mimeType
    : undefined;

  const nativelyDecodable = mimeType
    ? await abortable(signal, canDecodeImageType(mimeType))
    : false;

  const runBuiltin = () => builtinDecode(signal, blob, mimeType, colorSpace);
  const runWasm = wasmMimeType
    ? async () => {
        const bridge = await resolveBridge(options);
        const buffer = await abortable(signal, blob.arrayBuffer());
        return bridge.decode(signal, wasmMimeType, buffer);
      }
    : undefined;

  interface Attempt {
    builtin: boolean;
    run: () => Promise<ImageData>;
  }

  const builtinAttempt: Attempt = { builtin: true, run: runBuiltin };
  const wasmAttempt: Attempt | undefined = runWasm
    ? { builtin: false, run: runWasm }
    : undefined;

  // Preferred path first, the other one as a second chance.
  const attempts: Attempt[] =
    nativelyDecodable || !wasmAttempt
      ? [builtinAttempt, ...(wasmAttempt ? [wasmAttempt] : [])]
      : [wasmAttempt, builtinAttempt];

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const data = await attempt.run();
      return { data, mimeType, usedBuiltinDecoder: attempt.builtin, ...(hdr ? { hdr } : {}) };
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = error;
    }
  }

  throw decodeFailure(mimeType, lastError);
}

/** {@link decodeBlob} for a `File`, using its name for the extension fallback. */
export function decodeFile(
  signal: AbortSignal,
  file: File,
  options: DecodeImageOptions = {},
): Promise<DecodeResult> {
  return decodeBlob(signal, file, file.name, options);
}

/**
 * Decode straight into the shape the job engine keeps as its source of truth.
 */
export async function decodeToSourceImage(
  signal: AbortSignal,
  file: File,
  options: DecodeImageOptions = {},
): Promise<SourceImage> {
  const result = await decodeFile(signal, file, options);
  if (result.hdr) {
    return result.vector
      ? { file, decoded: result.data, vector: result.vector, hdr: result.hdr }
      : { file, decoded: result.data, hdr: result.hdr };
  }
  return result.vector
    ? { file, decoded: result.data, vector: result.vector }
    : { file, decoded: result.data };
}
