/**
 * The compare canvases' pure half: the contain-fit decision.
 *
 * `needsContainFit` is the single function keeping the two sides of the split
 * aligned when their pixel dimensions diverge (a resized encode letterboxes
 * into the reference box instead of stretching over it). It had no coverage —
 * this file is the regression net for the layer-alignment guarantee.
 */

import { describe, expect, it } from 'vitest';

import { needsContainFit } from './canvas';

describe('needsContainFit', () => {
  const size = (width: number, height: number) => ({ width, height });

  it('is false while either side is still missing', () => {
    expect(needsContainFit(undefined, undefined)).toBe(false);
    expect(needsContainFit(size(800, 600), undefined)).toBe(false);
    expect(needsContainFit(undefined, size(800, 600))).toBe(false);
  });

  it('is false when the side matches the reference exactly', () => {
    expect(needsContainFit(size(1320, 2868), size(1320, 2868))).toBe(false);
    expect(needsContainFit(size(1, 1), size(1, 1))).toBe(false);
  });

  it('letterboxes on any dimension mismatch, either axis, either direction', () => {
    expect(needsContainFit(size(660, 1434), size(1320, 2868))).toBe(true);
    expect(needsContainFit(size(2640, 5736), size(1320, 2868))).toBe(true);
    expect(needsContainFit(size(1320, 2867), size(1320, 2868))).toBe(true);
    expect(needsContainFit(size(1319, 2868), size(1320, 2868))).toBe(true);
  });

  it('letterboxes a same-area, different-aspect side (rotate without recrop)', () => {
    expect(needsContainFit(size(2868, 1320), size(1320, 2868))).toBe(true);
  });
});
