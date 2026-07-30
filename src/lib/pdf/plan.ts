/**
 * The pure decision layer of PDF recompression.
 *
 * Given one image's metadata and the run's settings, it answers the two
 * questions the orchestrator must settle before it spends a decode: should we
 * touch this image at all, and if so, to what size. No pixels, no pdf-lib, no
 * browser — just judgements over the `PdfImageInfo` the analysis pass produced.
 *
 * It is split out from the mechanics precisely because these are the parts worth
 * exhausting in unit tests: every skip reason and every resample-target branch
 * is reachable from a plain object literal, with no PDF to build.
 */

import { PDF_MIN_IMAGE_BYTES, PDF_RECOMPRESSIBLE_FILTERS } from '../contracts';
import type { PdfCompressSettings, PdfImageInfo, PdfSkipReason } from '../contracts';

/**
 * Why an image should be left exactly as found, or `undefined` when it is
 * eligible for recompression.
 *
 * Rules are checked in a fixed precedence — the first that matches wins — so an
 * image that is both a mask and CMYK reports `'mask'`, the more fundamental
 * reason. `'not-smaller'` and `'error'` are never returned here: they are
 * outcomes the orchestrator discovers only after attempting the work.
 */
export function imageSkipReason(
  info: PdfImageInfo,
  settings: PdfCompressSettings,
): PdfSkipReason | undefined {
  // 1. Stencils and colour-key masks: nothing to gain, plenty to break.
  if (info.isMask) return 'mask';
  // 2. CMYK: Adobe writes it inverted behind an APP14 marker; getting that wrong
  //    yields a colour negative, not a soft image. Refuse rather than risk it.
  if (info.colorSpace === '/DeviceCMYK') return 'cmyk';
  // 3. A filter we ship no decoder for (JPX, CCITT, JBIG2, LZW, RunLength, and
  //    the 'unknown' catch-all).
  if (!PDF_RECOMPRESSIBLE_FILTERS.includes(info.filter)) return 'no-decoder';
  // 4. Flate is only ever recompressed by re-encoding it to JPEG; with that
  //    switched off there is no decoder path left. Reuses 'no-decoder' to keep
  //    the contract enum closed rather than inventing a "disabled" reason.
  if (info.filter === 'FlateDecode' && !settings.flateToJpeg) return 'no-decoder';
  // 5. Only 8-bit samples are handled — 1/2/4/16-bit would need bit-unpacking
  //    the decode layer deliberately does not do.
  if (info.bitsPerComponent !== 8) return 'colorspace';
  // 6. Only the two device spaces decode cleanly. Indexed, Separation, ICCBased,
  //    CalRGB, Lab and anything else are left untouched.
  if (info.colorSpace !== '/DeviceRGB' && info.colorSpace !== '/DeviceGray') return 'colorspace';
  // 7. A non-identity /Decode remaps samples on the way out of the stream. No
  //    decode path here applies it and `replaceImageStream` drops the key, so a
  //    grayscale [1 0] would come back inverted. Reuses 'colorspace' — it is a
  //    sample-mapping refusal — rather than widening the contract enum.
  if (info.hasCustomDecode) return 'colorspace';
  // 8. Below the floor, a decode plus an encode costs more than it can save.
  if (info.srcBytes < PDF_MIN_IMAGE_BYTES) return 'too-small';
  return undefined;
}

/**
 * The pixel dimensions an image should be resampled to, or `null` to keep it at
 * its stored size.
 *
 * Two regimes, never mixed:
 *  - The image was placed by the content-stream walk (`effectiveDpi` known): the
 *    DPI target governs and the absolute pixel cap does **not** apply, because
 *    `maxPixels` exists only as the fallback for images we could not place.
 *  - The image was never placed: fall back to an absolute longest-edge ceiling.
 *
 * Never upscales (the scale is always below 1 by construction) and never returns
 * a no-op — if rounding lands back on the native size, it returns `null`.
 */
export function resampleTarget(
  info: PdfImageInfo,
  settings: PdfCompressSettings,
): { width: number; height: number } | null {
  let scale: number;
  if (info.effectiveDpi !== undefined) {
    if (settings.targetDpi === null || info.effectiveDpi <= settings.targetDpi) return null;
    scale = settings.targetDpi / info.effectiveDpi;
  } else {
    const longest = Math.max(info.width, info.height);
    if (settings.maxPixels === null || longest <= settings.maxPixels) return null;
    scale = settings.maxPixels / longest;
  }

  const width = Math.max(1, Math.round(info.width * scale));
  const height = Math.max(1, Math.round(info.height * scale));
  // scale < 1, but rounding can still reproduce the native size — nothing to do.
  if (width >= info.width && height >= info.height) return null;
  return { width, height };
}
