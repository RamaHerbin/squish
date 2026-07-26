/**
 * Pure `ImageData` transforms for the light-editing step: rotation and
 * cropping. These run in the preprocess stage of the pipeline
 * (decode → preprocess (rotate, crop) → process (resize) → encode), applied
 * once to the source and shared by both editor sides.
 *
 * Implementation notes:
 * - Rotation is plain typed-array index arithmetic — no `<canvas>` involved —
 *   so it runs identically on the main thread, inside a worker, or under a
 *   bare Node test runner.
 * - `ImageData` is a DOM/Worker global that plain Node does not provide.
 *   Every function here still returns something that satisfies the
 *   `ImageData` *interface* (safe to feed to `putImageData` or an
 *   `@jsquash/*` encoder): it constructs a real `ImageData` when the
 *   constructor exists, and falls back to a duck-typed object otherwise so
 *   these functions stay unit-testable without a DOM.
 *
 * Dependency-free: only imports types from `../contracts`.
 */

import type { CropRect, RotateAngle } from '../contracts';

/** Build an `ImageData`-shaped value without requiring the DOM constructor. */
function makeImageData(
  data: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
  colorSpace: PredefinedColorSpace = 'srgb',
): ImageData {
  if (typeof ImageData !== 'undefined') {
    return new ImageData(data, width, height, { colorSpace });
  }
  // Duck-typed fallback for non-DOM environments (unit tests). Shape matches
  // the `ImageData` interface closely enough for anything that only reads
  // `data`/`width`/`height`.
  return { data, width, height, colorSpace } as ImageData;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

/**
 * Rotate 90° clockwise. Output dimensions are swapped: `width` becomes the
 * source `height` and vice versa.
 */
export function rotate90(src: ImageData): ImageData {
  const { width: srcW, height: srcH, data: s } = src;
  const dstW = srcH;
  const dstH = srcW;
  const out = new Uint8ClampedArray(s.length);

  for (let dstY = 0; dstY < dstH; dstY++) {
    const srcX = dstY;
    const dstRowStart = dstY * dstW * 4;
    for (let dstX = 0; dstX < dstW; dstX++) {
      const srcY = srcH - 1 - dstX;
      const srcI = (srcY * srcW + srcX) * 4;
      const dstI = dstRowStart + dstX * 4;
      out[dstI] = s[srcI] ?? 0;
      out[dstI + 1] = s[srcI + 1] ?? 0;
      out[dstI + 2] = s[srcI + 2] ?? 0;
      out[dstI + 3] = s[srcI + 3] ?? 0;
    }
  }
  return makeImageData(out, dstW, dstH, src.colorSpace);
}

/** Rotate 180°. Dimensions are unchanged. */
export function rotate180(src: ImageData): ImageData {
  const { width, height, data: s } = src;
  const pixelCount = width * height;
  const out = new Uint8ClampedArray(s.length);

  for (let i = 0; i < pixelCount; i++) {
    const srcI = i * 4;
    const dstI = (pixelCount - 1 - i) * 4;
    out[dstI] = s[srcI] ?? 0;
    out[dstI + 1] = s[srcI + 1] ?? 0;
    out[dstI + 2] = s[srcI + 2] ?? 0;
    out[dstI + 3] = s[srcI + 3] ?? 0;
  }
  return makeImageData(out, width, height, src.colorSpace);
}

/**
 * Rotate 270° clockwise (= 90° counter-clockwise). Output dimensions are
 * swapped, same as {@link rotate90}.
 */
export function rotate270(src: ImageData): ImageData {
  const { width: srcW, height: srcH, data: s } = src;
  const dstW = srcH;
  const dstH = srcW;
  const out = new Uint8ClampedArray(s.length);

  for (let dstY = 0; dstY < dstH; dstY++) {
    const srcX = srcW - 1 - dstY;
    const dstRowStart = dstY * dstW * 4;
    for (let dstX = 0; dstX < dstW; dstX++) {
      const srcY = dstX;
      const srcI = (srcY * srcW + srcX) * 4;
      const dstI = dstRowStart + dstX * 4;
      out[dstI] = s[srcI] ?? 0;
      out[dstI + 1] = s[srcI + 1] ?? 0;
      out[dstI + 2] = s[srcI + 2] ?? 0;
      out[dstI + 3] = s[srcI + 3] ?? 0;
    }
  }
  return makeImageData(out, dstW, dstH, src.colorSpace);
}

/**
 * Dispatch to the matching rotation for a {@link RotateAngle}. `0` still
 * returns a fresh copy (never the same reference) so callers can always
 * treat the result as an owned, mutable buffer.
 */
export function rotate(src: ImageData, angle: RotateAngle): ImageData {
  switch (angle) {
    case 0:
      return makeImageData(new Uint8ClampedArray(src.data), src.width, src.height, src.colorSpace);
    case 90:
      return rotate90(src);
    case 180:
      return rotate180(src);
    case 270:
      return rotate270(src);
  }
}

/**
 * Extract the sub-region described by `rect`. Coordinates/size are rounded
 * to integers and clamped inside the source bounds (never reads out of
 * bounds, never produces an empty result) — callers doing live drag-resize
 * do not need to pre-validate the rect themselves.
 */
export function cropImageData(src: ImageData, rect: CropRect): ImageData {
  const srcW = src.width;
  const srcH = src.height;

  const x = clampInt(rect.x, 0, Math.max(0, srcW - 1));
  const y = clampInt(rect.y, 0, Math.max(0, srcH - 1));
  const width = clampInt(rect.width, 1, Math.max(1, srcW - x));
  const height = clampInt(rect.height, 1, Math.max(1, srcH - y));

  const out = new Uint8ClampedArray(width * height * 4);
  const srcData = src.data;
  for (let row = 0; row < height; row++) {
    const srcStart = ((y + row) * srcW + x) * 4;
    const dstStart = row * width * 4;
    out.set(srcData.subarray(srcStart, srcStart + width * 4), dstStart);
  }
  return makeImageData(out, width, height, src.colorSpace);
}
