import { describe, expect, it } from 'vitest';

import { cropImageData, rotate, rotate180, rotate270, rotate90 } from './transform';

/**
 * Node has no DOM, so there is no global `ImageData` constructor here either
 * — exactly the environment `transform.ts` is designed to tolerate. Build
 * plain objects satisfying the `ImageData` interface directly.
 */
function image(width: number, height: number, pixels: readonly (readonly number[])[]): ImageData {
  return {
    width,
    height,
    data: new Uint8ClampedArray(pixels.flat()),
    colorSpace: 'srgb',
  } as ImageData;
}

describe('rotate90', () => {
  it('swaps dimensions and maps the left column to the top row', () => {
    // 2×1 source: A (left) | B (right)
    const src = image(2, 1, [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
    ]);
    const out = rotate90(src);

    expect(out.width).toBe(1);
    expect(out.height).toBe(2);
    // Rotating clockwise: the left edge becomes the top edge.
    expect(Array.from(out.data)).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  });

  it('does not mutate the source', () => {
    const src = image(2, 1, [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    const before = Array.from(src.data);
    rotate90(src);
    expect(Array.from(src.data)).toEqual(before);
  });
});

describe('rotate270', () => {
  it('swaps dimensions and maps the right column to the top row', () => {
    const src = image(2, 1, [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
    ]);
    const out = rotate270(src);

    expect(out.width).toBe(1);
    expect(out.height).toBe(2);
    // Rotating counter-clockwise: the right edge becomes the top edge.
    expect(Array.from(out.data)).toEqual([0, 255, 0, 255, 255, 0, 0, 255]);
  });
});

describe('rotate180', () => {
  it('keeps dimensions and reverses pixel order', () => {
    const src = image(2, 2, [
      [1, 0, 0, 255],
      [2, 0, 0, 255],
      [3, 0, 0, 255],
      [4, 0, 0, 255],
    ]);
    const out = rotate180(src);

    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect(Array.from(out.data)).toEqual([
      4, 0, 0, 255, 3, 0, 0, 255, 2, 0, 0, 255, 1, 0, 0, 255,
    ]);
  });
});

describe('four 90° rotations', () => {
  it('return to the original pixels and dimensions', () => {
    const width = 3;
    const height = 2;
    const pixels = Array.from({ length: width * height }, (_, i) => [i, i, i, 255]);
    let out = image(width, height, pixels);
    for (let i = 0; i < 4; i++) out = rotate90(out);

    expect(out.width).toBe(width);
    expect(out.height).toBe(height);
    expect(Array.from(out.data)).toEqual(pixels.flat());
  });
});

describe('rotate (dispatch)', () => {
  const src = image(2, 1, [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
  ]);

  it('0° returns a fresh copy, never the same reference', () => {
    const out = rotate(src, 0);
    expect(out).not.toBe(src);
    expect(out.data).not.toBe(src.data);
    expect(out.width).toBe(src.width);
    expect(out.height).toBe(src.height);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('90/180/270 match the dedicated helpers', () => {
    expect(Array.from(rotate(src, 90).data)).toEqual(Array.from(rotate90(src).data));
    expect(Array.from(rotate(src, 180).data)).toEqual(Array.from(rotate180(src).data));
    expect(Array.from(rotate(src, 270).data)).toEqual(Array.from(rotate270(src).data));
  });
});

describe('cropImageData', () => {
  // 3×2 source, one red-channel value per pixel for easy identification:
  // 1 2 3
  // 4 5 6
  const src = image(3, 2, [
    [1, 0, 0, 255],
    [2, 0, 0, 255],
    [3, 0, 0, 255],
    [4, 0, 0, 255],
    [5, 0, 0, 255],
    [6, 0, 0, 255],
  ]);

  it('extracts the requested sub-rectangle', () => {
    const out = cropImageData(src, { x: 1, y: 0, width: 2, height: 2 });
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect(Array.from(out.data)).toEqual([2, 0, 0, 255, 3, 0, 0, 255, 5, 0, 0, 255, 6, 0, 0, 255]);
  });

  it('clamps a rect that overhangs the source bounds', () => {
    const out = cropImageData(src, { x: 2, y: 1, width: 10, height: 10 });
    expect(out.width).toBe(1);
    expect(out.height).toBe(1);
    expect(Array.from(out.data)).toEqual([6, 0, 0, 255]);
  });

  it('never produces an empty result', () => {
    const out = cropImageData(src, { x: 0, y: 0, width: 0, height: 0 });
    expect(out.width).toBeGreaterThanOrEqual(1);
    expect(out.height).toBeGreaterThanOrEqual(1);
  });

  it('does not mutate the source', () => {
    const before = Array.from(src.data);
    cropImageData(src, { x: 0, y: 0, width: 1, height: 1 });
    expect(Array.from(src.data)).toEqual(before);
  });
});
