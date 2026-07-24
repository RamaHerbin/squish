import { describe, expect, it } from 'vitest';

import {
  ASPECT_PRESETS,
  CROP_HANDLES,
  MIN_CROP_SIZE,
  applyAspect,
  clampCropRect,
  cursorForHandle,
  fullImageCrop,
  moveCropRect,
  resizeCropRect,
} from './geometry';

const bounds = { width: 100, height: 80 };

describe('fullImageCrop', () => {
  it('covers the whole image from the origin', () => {
    expect(fullImageCrop(bounds)).toEqual({ x: 0, y: 0, width: 100, height: 80 });
  });
});

describe('clampCropRect', () => {
  it('leaves a valid in-bounds rect untouched', () => {
    expect(clampCropRect({ x: 10, y: 10, width: 20, height: 20 }, bounds)).toEqual({
      x: 10,
      y: 10,
      width: 20,
      height: 20,
    });
  });

  it('pulls an out-of-bounds rect back inside the image', () => {
    const out = clampCropRect({ x: 90, y: 70, width: 30, height: 30 }, bounds);
    expect(out.x).toBeGreaterThanOrEqual(0);
    expect(out.y).toBeGreaterThanOrEqual(0);
    expect(out.x + out.width).toBeLessThanOrEqual(bounds.width);
    expect(out.y + out.height).toBeLessThanOrEqual(bounds.height);
  });

  it('enforces the minimum crop size', () => {
    const out = clampCropRect({ x: 5, y: 5, width: 1, height: 1 }, bounds);
    expect(out.width).toBeGreaterThanOrEqual(MIN_CROP_SIZE);
    expect(out.height).toBeGreaterThanOrEqual(MIN_CROP_SIZE);
  });

  it('shrinks the minimum for an image smaller than MIN_CROP_SIZE', () => {
    const tinyBounds = { width: 4, height: 4 };
    expect(clampCropRect({ x: 0, y: 0, width: 100, height: 100 }, tinyBounds)).toEqual({
      x: 0,
      y: 0,
      width: 4,
      height: 4,
    });
  });

  it('rounds fractional input to integers', () => {
    const out = clampCropRect({ x: 1.4, y: 1.6, width: 20.5, height: 20.4 }, bounds);
    expect(Number.isInteger(out.x)).toBe(true);
    expect(Number.isInteger(out.y)).toBe(true);
    expect(Number.isInteger(out.width)).toBe(true);
    expect(Number.isInteger(out.height)).toBe(true);
  });
});

describe('moveCropRect', () => {
  it('translates by the given delta', () => {
    const rect = { x: 10, y: 10, width: 20, height: 20 };
    expect(moveCropRect(rect, 5, -3, bounds)).toEqual({ x: 15, y: 7, width: 20, height: 20 });
  });

  it('clamps so the rect stays fully inside the image', () => {
    const rect = { x: 10, y: 10, width: 20, height: 20 };
    const out = moveCropRect(rect, 1000, 1000, bounds);
    expect(out).toEqual({ x: bounds.width - 20, y: bounds.height - 20, width: 20, height: 20 });
  });
});

describe('applyAspect', () => {
  it('is a no-op (aside from clamping) for a null ratio', () => {
    const rect = { x: 10, y: 10, width: 20, height: 30 };
    expect(applyAspect(rect, null, bounds)).toEqual(clampCropRect(rect, bounds));
  });

  it('produces a rect matching the requested ratio', () => {
    const rect = { x: 10, y: 10, width: 20, height: 30 };
    const out = applyAspect(rect, 1, bounds);
    expect(out.width / out.height).toBeCloseTo(1, 1);
  });

  it('never exceeds the image bounds', () => {
    const rect = { x: 0, y: 0, width: 100, height: 80 };
    const out = applyAspect(rect, 16 / 9, bounds);
    expect(out.x).toBeGreaterThanOrEqual(0);
    expect(out.y).toBeGreaterThanOrEqual(0);
    expect(out.x + out.width).toBeLessThanOrEqual(bounds.width);
    expect(out.y + out.height).toBeLessThanOrEqual(bounds.height);
  });
});

describe('resizeCropRect', () => {
  const rect = { x: 20, y: 20, width: 40, height: 30 };

  it('drags the se handle to grow the rect from its fixed nw corner', () => {
    const out = resizeCropRect(rect, 'se', { x: 70, y: 60 }, bounds, null);
    expect(out).toEqual({ x: 20, y: 20, width: 50, height: 40 });
  });

  it('drags the nw handle without moving the fixed se corner', () => {
    const out = resizeCropRect(rect, 'nw', { x: 10, y: 10 }, bounds, null);
    expect(out.x).toBe(10);
    expect(out.y).toBe(10);
    expect(out.x + out.width).toBe(60);
    expect(out.y + out.height).toBe(50);
  });

  it('enforces the minimum size instead of collapsing or inverting', () => {
    const out = resizeCropRect(rect, 'e', { x: 0, y: 0 }, bounds, null);
    expect(out.width).toBeGreaterThanOrEqual(MIN_CROP_SIZE);
    expect(out.x).toBe(20); // 'e' only drags the right edge
  });

  it('never leaves the image bounds', () => {
    const out = resizeCropRect(rect, 'se', { x: 1000, y: 1000 }, bounds, null);
    expect(out.x + out.width).toBeLessThanOrEqual(bounds.width);
    expect(out.y + out.height).toBeLessThanOrEqual(bounds.height);
  });

  it('keeps width/height locked to the ratio when one is set', () => {
    const out = resizeCropRect(rect, 'e', { x: 90, y: 20 }, bounds, 2);
    expect(out.width / out.height).toBeCloseTo(2, 1);
  });
});

describe('cursorForHandle', () => {
  it('returns a resize cursor for every handle', () => {
    for (const handle of CROP_HANDLES) {
      expect(cursorForHandle(handle)).toMatch(/resize$/);
    }
  });
});

describe('ASPECT_PRESETS', () => {
  it('starts with Free (null ratio)', () => {
    expect(ASPECT_PRESETS[0]).toEqual({ label: 'Free', ratio: null });
  });
});
