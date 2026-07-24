/**
 * Canvas-free, wasm-free image rotation.
 *
 * A 90° multiple is a pure index permutation, so there is nothing to gain from
 * shipping a codec for it. Working on a `Uint32Array` view moves whole RGBA
 * pixels per iteration, which is roughly 4× faster than byte copies and needs
 * no endianness handling because the value is never inspected.
 *
 * Deliberately dependency-free and `ImageData`-free so it can be unit-tested in
 * Node and imported by the worker without dragging the DOM along.
 */

import type { RotateAngle, TransferableImageData } from '../contracts';

/** A 32-bit (one pixel per element) view over an RGBA byte buffer. */
function pixelView(data: Uint8ClampedArray): Uint32Array {
  return new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4);
}

/**
 * Rotate clockwise by `angle` degrees.
 *
 * `0` returns the input untouched (same object, same buffer). Every other angle
 * allocates a fresh buffer and leaves the input intact.
 *
 * @throws when the pixel buffer length does not match `width × height × 4`.
 */
export function rotateTransferable(
  image: TransferableImageData,
  angle: RotateAngle,
): TransferableImageData {
  const { width, height, data } = image;

  if (data.byteLength !== width * height * 4) {
    throw new Error(
      `Pixel buffer of ${data.byteLength} bytes does not match ${width}×${height} RGBA`,
    );
  }

  if (angle === 0) return image;

  const flipped = angle === 90 || angle === 270;
  const outWidth = flipped ? height : width;
  const outHeight = flipped ? width : height;

  const source = pixelView(data);
  const outBytes = new Uint8ClampedArray(width * height * 4);
  const out = pixelView(outBytes);

  if (angle === 180) {
    const last = width * height - 1;
    for (let i = 0; i <= last; i++) out[last - i] = source[i] as number;
  } else if (angle === 90) {
    // (sx, sy) -> (height - 1 - sy, sx); destination stride is `height`.
    for (let sy = 0; sy < height; sy++) {
      const rowStart = sy * width;
      const destColumn = height - 1 - sy;
      for (let sx = 0; sx < width; sx++) {
        out[sx * outWidth + destColumn] = source[rowStart + sx] as number;
      }
    }
  } else {
    // 270°: (sx, sy) -> (sy, width - 1 - sx).
    for (let sy = 0; sy < height; sy++) {
      const rowStart = sy * width;
      for (let sx = 0; sx < width; sx++) {
        out[(width - 1 - sx) * outWidth + sy] = source[rowStart + sx] as number;
      }
    }
  }

  return { data: outBytes, width: outWidth, height: outHeight };
}

/**
 * The angle the resize width/height should be read at after a rotation change.
 * A quarter turn swaps the axes, so the user's "1920 wide" keeps meaning the
 * same edge of the picture.
 */
export function rotationSwapsAxes(from: RotateAngle, to: RotateAngle): boolean {
  const fromFlipped = from === 90 || from === 270;
  const toFlipped = to === 90 || to === 270;
  return fromFlipped !== toFlipped;
}
