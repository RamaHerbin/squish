/**
 * Turn one embedded PDF image XObject into `ImageData` the codec worker can
 * re-encode, and resample that `ImageData` when the plan asks to shrink it.
 *
 * This is the one browser-only module in the recompression layer: it reaches a
 * canvas (via `builtinResize`) and a codec worker (via the bridge). To stay
 * importable from Node — `compress.ts` pulls it in statically and node tests
 * load that graph — every canvas/worker touch lives inside a function body;
 * nothing at module scope evaluates a DOM global.
 *
 * Two decode routes, picked by the stored filter:
 *  - DCTDecode: hand the raw JPEG bytes straight to the worker's JPEG decoder,
 *    which owns all colorspace/bpc/APP14 handling. We never flate or unpack it.
 *  - FlateDecode: unpack the zlib stream ourselves into byte-aligned rows and
 *    fan them out to RGBA. SkipMap guarantees the only shapes that reach here
 *    are 8-bit `/DeviceRGB` or `/DeviceGray`, so there is no bit-unpacking, no
 *    row padding, and no palette to resolve.
 *
 * Soft masks: when the image carries an `/SMask`, we fold its grey samples into
 * the alpha channel. This is best-effort — the re-encoded baseline JPEG cannot
 * carry alpha and `rewrite.ts` drops `/SMask` on replace, so semi-transparent
 * pixels flatten to their raw RGB. Accepted for v1; a mask we cannot cheaply
 * decode degrades to fully opaque rather than failing the whole image.
 */

import { PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from '@cantoo/pdf-lib';

import { builtinResize } from '../codecs';
import type { PdfImageInfo, WorkerBridgeApi } from '../contracts';

/** Interned name keys, looked up once. `PDFName.of` pools, so this is cheap. */
const KEY = {
  SMask: PDFName.of('SMask'),
  Filter: PDFName.of('Filter'),
  BitsPerComponent: PDFName.of('BitsPerComponent'),
  Width: PDFName.of('Width'),
  Height: PDFName.of('Height'),
} as const;

/** Everything a decode needs from the caller that a pure module cannot hold. */
export interface PdfDecodeDeps {
  readonly bridge: WorkerBridgeApi;
  readonly signal: AbortSignal;
}

/**
 * Decode one image XObject to `ImageData`, ready for re-encoding.
 *
 * The route is chosen by `info.filter`, which the caller has already narrowed:
 * only `DCTDecode` and `FlateDecode` reach this function (SkipMap turns every
 * other filter into a `'no-decoder'` skip). The Flate branch additionally relies
 * on SkipMap's guarantee of 8 bits per component in `/DeviceRGB` or
 * `/DeviceGray`; it does no bit-unpacking or colour conversion of its own.
 *
 * When `info.hasSMask` is set, the soft mask is folded into the alpha channel on
 * a best-effort basis: an SMask we cannot cheaply decode (not a Flate, 8-bit
 * `PDFRawStream`, or a decode that throws) leaves the image opaque rather than
 * failing it.
 *
 * @throws whatever `bridge.decode` throws on the DCT path (including abort), and
 *   any error from `decodePDFRawStream(...).decode()` on the Flate path. The
 *   orchestrator turns non-abort throws into an `'error'` outcome.
 */
export async function decodePdfImageData(
  deps: PdfDecodeDeps,
  stream: PDFRawStream,
  info: PdfImageInfo,
): Promise<ImageData> {
  let image: ImageData;

  if (info.filter === 'DCTDecode') {
    // Do NOT flate/unpack — these are already JPEG. The copy is mandatory:
    // `bridge.decode` detaches the buffer it receives via a Comlink transfer,
    // and `stream` must stay intact for the not-smaller / SSIM paths.
    const stored = stream.getContents();
    const buffer = stored.slice().buffer;
    image = await deps.bridge.decode(deps.signal, 'image/jpeg', buffer);
  } else {
    image = decodeFlateToImageData(stream, info);
  }

  if (info.hasSMask) applySoftMask(stream, image);
  return image;
}

/**
 * Unpack an 8-bit `/DeviceRGB` or `/DeviceGray` Flate stream into RGBA.
 *
 * Preconditions (bpc 8, one of the two device spaces) are SkipMap's promise, so
 * rows are byte-aligned with no padding to compute and each sample maps 1:1.
 */
function decodeFlateToImageData(stream: PDFRawStream, info: PdfImageInfo): ImageData {
  const raw = decodePDFRawStream(stream).decode();
  const { width, height } = info;
  const rgb = info.colorSpace === '/DeviceRGB'; // else /DeviceGray
  const rowBytes = width * (rgb ? 3 : 1);
  const out = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (rgb) {
        const i = rowStart + x * 3;
        out[o] = raw[i]!;
        out[o + 1] = raw[i + 1]!;
        out[o + 2] = raw[i + 2]!;
      } else {
        const i = rowStart + x;
        out[o] = out[o + 1] = out[o + 2] = raw[i]!;
      }
      out[o + 3] = 255;
    }
  }

  return new ImageData(out, width, height);
}

/**
 * Fold an image's `/SMask` grey samples into `image`'s alpha channel in place.
 *
 * Best-effort by design: a mask that is not a self-contained Flate, 8-bit
 * `PDFRawStream`, or that fails to decode, leaves alpha untouched (opaque). The
 * mask is sampled nearest-neighbour so mismatched dimensions still map — the
 * same-size case is that formula with `sx = x`, `sy = y`, needing no branch.
 */
function applySoftMask(stream: PDFRawStream, image: ImageData): void {
  try {
    const smaskRef = stream.dict.get(KEY.SMask);
    if (!(smaskRef instanceof PDFRef)) return;

    const smask = stream.dict.context.lookup(smaskRef);
    if (!(smask instanceof PDFRawStream)) return;

    const filter = smask.dict.lookup(KEY.Filter);
    if (!(filter instanceof PDFName) || filter.asString() !== '/FlateDecode') return;

    const bpc = smask.dict.lookup(KEY.BitsPerComponent);
    if (!(bpc instanceof PDFNumber) || bpc.asNumber() !== 8) return;

    const smaskWidth = smask.dict.lookup(KEY.Width);
    const smaskHeight = smask.dict.lookup(KEY.Height);
    if (!(smaskWidth instanceof PDFNumber) || !(smaskHeight instanceof PDFNumber)) return;

    const mw = smaskWidth.asNumber();
    const mh = smaskHeight.asNumber();
    if (mw < 1 || mh < 1) return;

    const smaskRaw = decodePDFRawStream(smask).decode();
    const { width, height, data } = image;
    for (let y = 0; y < height; y += 1) {
      const sy = Math.floor((y * mh) / height);
      for (let x = 0; x < width; x += 1) {
        const sx = Math.floor((x * mw) / width);
        data[(y * width + x) * 4 + 3] = smaskRaw[sy * mw + sx]!;
      }
    }
  } catch {
    // Degrade to opaque: a broken mask must not sink an otherwise-fine image.
  }
}

/**
 * Resample `data` to `size` with the browser's own high-quality scaler.
 *
 * `builtinResize` threads `colorSpaceOf(data)` through internally, so there is
 * nothing extra to preserve here. It reaches a canvas and therefore throws in
 * Node — which is why the orchestrator injects a fake in tests and takes the
 * real implementation only in the browser.
 */
export function resampleImageData(
  data: ImageData,
  size: { width: number; height: number },
): ImageData {
  return builtinResize(data, 0, 0, data.width, data.height, size.width, size.height, 'high');
}
