/**
 * Structural similarity, the number behind the editor's `SSIM 0.994` cell, the
 * matrix cells and the Auto pill.
 *
 * Pure and dependency-free: no DOM, no worker, no `ImageData` constructor — it
 * reads `{ data, width, height }` and returns plain values, so the whole file
 * runs under vitest in a node environment with hand-built pixel arrays.
 *
 * ## The metric
 * Single-scale SSIM on the Rec.709 luma plane, 8×8 windows at stride 8
 * (non-overlapping), with the standard constants K1 = 0.01, K2 = 0.03,
 * L = 255 → C1 = 6.5025, C2 = 58.5225. Per-window means and (population)
 * variances, exactly as in the reference `ssim_index.m` with a flat normalised
 * window, then the arithmetic mean over every window.
 *
 * Deliberately *not* multi-scale and not Gaussian-weighted: this runs on every
 * slider commit and on 20 matrix cells, and the extra fidelity would buy
 * nothing a user could act on. It is stable, monotone in quality, and returns
 * exactly `1` for identical inputs, which is all the UI reads it for.
 *
 * ## Alpha
 * Ignored. Encoders that drop the alpha channel (JPEG) would otherwise score
 * arbitrarily badly on fully transparent pixels whose RGB is undefined. The
 * comparison is of the visible luma, which is what "does this look the same"
 * means here.
 *
 * ## Cost
 * ~O(pixels), one Float32Array per image. A 12 MP pair costs roughly 100 ms of
 * pure arithmetic, which is why {@link downscaleForMetrics} exists and why this
 * runs in `metrics.worker.ts` rather than on the main thread.
 */

import type { TransferableImageData } from '../contracts';

/* -------------------------------------------------------------------------- */
/* Types & constants                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Anything shaped like pixels: a real `ImageData`, a worker payload, or a test
 * fixture. `ImageData` is structurally assignable, so
 * `computeSsim(a: ImageData, b: ImageData)` type-checks at every call site.
 */
export type MetricsImage = TransferableImageData;

/** Stabiliser for the luminance term. */
export const SSIM_K1 = 0.01;
/** Stabiliser for the contrast/structure term. */
export const SSIM_K2 = 0.03;
/** Dynamic range of an 8-bit channel. */
export const SSIM_L = 255;
/** Window edge, in pixels. */
export const SSIM_WINDOW = 8;
/** Window step. Equal to {@link SSIM_WINDOW} — windows do not overlap. */
export const SSIM_STRIDE = 8;

const C1 = (SSIM_K1 * SSIM_L) ** 2;
const C2 = (SSIM_K2 * SSIM_L) ** 2;

/** Rec.709 luma weights. */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/**
 * Pixel budget for a comparison. Above this both images are box-averaged down
 * before the compare — 2 MP is well past the point where SSIM stops moving,
 * and it keeps a 48 MP pair from costing half a second.
 */
export const METRICS_MAX_PIXELS = 2_000_000;

/* -------------------------------------------------------------------------- */
/* Guards                                                                      */
/* -------------------------------------------------------------------------- */

/** True when both images cover the same pixel grid. */
export function sameDimensions(a: MetricsImage, b: MetricsImage): boolean {
  return a.width === b.width && a.height === b.height;
}

/**
 * SSIM is undefined across different pixel grids — with resize on there is no
 * correspondence between an input and an output pixel. Callers that can hit
 * that case (the editor, with Resize enabled) should check
 * {@link sameDimensions} first and report `ssim: null` rather than catching.
 */
export function assertComparable(a: MetricsImage, b: MetricsImage): void {
  if (!sameDimensions(a, b)) {
    throw new RangeError(
      `SSIM needs identical dimensions: ${a.width}x${a.height} vs ${b.width}x${b.height}`,
    );
  }
  if (a.width <= 0 || a.height <= 0) {
    throw new RangeError('SSIM needs a non-empty image');
  }
  assertPixelCount(a);
  assertPixelCount(b);
}

function assertPixelCount(image: MetricsImage): void {
  const expected = image.width * image.height * 4;
  if (image.data.length < expected) {
    throw new RangeError(
      `pixel buffer too short: ${image.data.length} bytes for ${image.width}x${image.height}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Luma                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Rec.709 luma plane, one float per pixel, alpha composited over white.
 *
 * Compositing matters: encoding a transparent source to an opaque format
 * (JPEG) keeps the hidden RGB values, so ignoring alpha would score the pair
 * near-identical while the transparent regions actually render as a solid
 * background. White matches the checkerboard-light rendering default.
 *
 * Exported for tests and for callers that want to compare several encodes
 * against one original without re-deriving its plane each time.
 */
export function toLuma(image: MetricsImage): Float32Array {
  assertPixelCount(image);
  const { data, width, height } = image;
  const count = width * height;
  const luma = new Float32Array(count);

  for (let i = 0, p = 0; i < count; i++, p += 4) {
    const pixel =
      LUMA_R * (data[p] ?? 0) + LUMA_G * (data[p + 1] ?? 0) + LUMA_B * (data[p + 2] ?? 0);
    const alpha = (data[p + 3] ?? 255) / 255;
    luma[i] = alpha === 1 ? pixel : pixel * alpha + 255 * (1 - alpha);
  }
  return luma;
}

/* -------------------------------------------------------------------------- */
/* SSIM                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Structural similarity of two same-sized images, in `[-1, 1]` — in practice
 * `[0, 1]` for an image and its encode, where `1` is pixel-identical.
 *
 * @throws RangeError when the dimensions differ or an image is empty.
 */
export function computeSsim(a: MetricsImage, b: MetricsImage): number {
  assertComparable(a, b);
  return ssimOfLuma(toLuma(a), toLuma(b), a.width, a.height);
}

/**
 * {@link computeSsim} on pre-extracted luma planes — the shape to use when one
 * original is compared against many encodes.
 */
export function ssimOfLuma(
  x: Float32Array,
  y: Float32Array,
  width: number,
  height: number,
): number {
  // An image smaller than a window still gets one window, clipped to its size,
  // rather than an empty average.
  const winW = Math.min(SSIM_WINDOW, width);
  const winH = Math.min(SSIM_WINDOW, height);
  if (winW <= 0 || winH <= 0) throw new RangeError('SSIM needs a non-empty image');

  let total = 0;
  let windows = 0;

  // Trailing pixels that cannot fill a whole window are dropped. Both images
  // are the same size, so both drop exactly the same pixels.
  for (let top = 0; top + winH <= height; top += SSIM_STRIDE) {
    for (let left = 0; left + winW <= width; left += SSIM_STRIDE) {
      total += windowSsim(x, y, width, left, top, winW, winH);
      windows++;
    }
  }

  if (windows === 0) return 1;
  return clampSsim(total / windows);
}

function windowSsim(
  x: Float32Array,
  y: Float32Array,
  stride: number,
  left: number,
  top: number,
  winW: number,
  winH: number,
): number {
  const n = winW * winH;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;

  for (let row = 0; row < winH; row++) {
    let index = (top + row) * stride + left;
    for (let col = 0; col < winW; col++, index++) {
      const vx = x[index] ?? 0;
      const vy = y[index] ?? 0;
      sumX += vx;
      sumY += vy;
      sumXX += vx * vx;
      sumYY += vy * vy;
      sumXY += vx * vy;
    }
  }

  const muX = sumX / n;
  const muY = sumY / n;
  // Population moments — the reference implementation's normalised window.
  const varX = sumXX / n - muX * muX;
  const varY = sumYY / n - muY * muY;
  const covXY = sumXY / n - muX * muY;

  const numerator = (2 * muX * muY + C1) * (2 * covXY + C2);
  const denominator = (muX * muX + muY * muY + C1) * (varX + varY + C2);
  if (denominator === 0) return 1;
  return numerator / denominator;
}

/** Float noise can push a perfect match a hair past 1. */
function clampSsim(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(-1, value));
}

/* -------------------------------------------------------------------------- */
/* Downscaling                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Integer box factor that brings `width x height` under `maxPixels`.
 * `1` means "already small enough". Integer on purpose: it makes the reduction
 * an exact box average with no resampling kernel, and — because it depends only
 * on the dimensions — two images of the same size always get the same factor.
 */
export function metricsScaleFactor(
  width: number,
  height: number,
  maxPixels: number = METRICS_MAX_PIXELS,
): number {
  const pixels = width * height;
  if (!Number.isFinite(maxPixels) || maxPixels <= 0) return 1;
  if (pixels <= maxPixels) return 1;
  return Math.max(1, Math.ceil(Math.sqrt(pixels / maxPixels)));
}

/**
 * Average each `factor x factor` block into one pixel.
 *
 * Returns the *same object* when `factor <= 1`, so the common "already small"
 * path costs nothing. Rows/columns past the last whole block are dropped;
 * identically-sized inputs therefore stay aligned pixel for pixel.
 */
export function downscaleBy(image: MetricsImage, factor: number): MetricsImage {
  const step = Math.max(1, Math.floor(factor));
  if (step === 1) return image;

  assertPixelCount(image);
  const { data, width, height } = image;
  const outW = Math.max(1, Math.floor(width / step));
  const outH = Math.max(1, Math.floor(height / step));
  const out = new Uint8ClampedArray(outW * outH * 4);
  const area = step * step;

  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;

      for (let sy = 0; sy < step; sy++) {
        const row = (oy * step + sy) * width;
        let p = (row + ox * step) * 4;
        for (let sx = 0; sx < step; sx++, p += 4) {
          r += data[p] ?? 0;
          g += data[p + 1] ?? 0;
          b += data[p + 2] ?? 0;
          alpha += data[p + 3] ?? 0;
        }
      }

      const q = (oy * outW + ox) * 4;
      out[q] = r / area;
      out[q + 1] = g / area;
      out[q + 2] = b / area;
      out[q + 3] = alpha / area;
    }
  }

  return { data: out, width: outW, height: outH };
}

/**
 * Bring one image under the metric's pixel budget by box averaging.
 * May return the input untouched — treat the result as read-only.
 */
export function downscaleForMetrics(
  image: MetricsImage,
  maxPixels: number = METRICS_MAX_PIXELS,
): MetricsImage {
  return downscaleBy(image, metricsScaleFactor(image.width, image.height, maxPixels));
}

/**
 * Downscale a pair *identically* — one factor derived once and applied to both,
 * which is the only way the reduced planes still correspond.
 *
 * @throws RangeError when the two images are not the same size.
 */
export function downscalePairForMetrics(
  a: MetricsImage,
  b: MetricsImage,
  maxPixels: number = METRICS_MAX_PIXELS,
): { a: MetricsImage; b: MetricsImage; factor: number } {
  assertComparable(a, b);
  const factor = metricsScaleFactor(a.width, a.height, maxPixels);
  return { a: downscaleBy(a, factor), b: downscaleBy(b, factor), factor };
}

/**
 * The full comparison as the worker runs it: reduce both images with one
 * factor, then score. Exported so the metric can be computed synchronously in
 * a test or a fallback path without a worker.
 */
export function measureSsim(
  a: MetricsImage,
  b: MetricsImage,
  maxPixels: number = METRICS_MAX_PIXELS,
): number {
  const pair = downscalePairForMetrics(a, b, maxPixels);
  return computeSsim(pair.a, pair.b);
}
