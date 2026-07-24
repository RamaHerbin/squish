/**
 * The reveal surface's pure half: divider maths, zoom formatting and the
 * container ⇄ image coordinate mapping the crop tool is wired through.
 *
 * No DOM — the components only measure and delegate, so everything worth
 * asserting lives in `reveal.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  COMPACT_REVEAL_SPLIT,
  DEFAULT_REVEAL_SPLIT,
  SPLIT_KEY_STEP,
  SPLIT_KEY_STEP_LARGE,
  ZOOM_STEP,
  clampSplit,
  contentOrigin,
  formatZoomPercent,
  isTypingTarget,
  parseZoomScale,
  splitForDigit,
  splitForKey,
  splitFromDrag,
  splitPercent,
  toImagePointIn,
  toViewportPointIn,
  zoomInScale,
  zoomOutScale,
  type RevealLayout,
} from './reveal';

/** 800×600 surface holding a 400×300 image at 1:1, dead centre. */
const centred: RevealLayout = {
  containerWidth: 800,
  containerHeight: 600,
  contentWidth: 400,
  contentHeight: 300,
  x: 0,
  y: 0,
  scale: 1,
};

describe('constants', () => {
  it('matches the comps: 46% desktop, 52% mobile', () => {
    expect(DEFAULT_REVEAL_SPLIT).toBe(0.46);
    expect(COMPACT_REVEAL_SPLIT).toBe(0.52);
  });
});

describe('clampSplit', () => {
  it('keeps the fraction inside 0–1', () => {
    expect(clampSplit(-0.2)).toBe(0);
    expect(clampSplit(1.4)).toBe(1);
    expect(clampSplit(0.46)).toBe(0.46);
  });

  it('falls back to the centre for nonsense', () => {
    expect(clampSplit(Number.NaN)).toBe(0.5);
    expect(clampSplit(Number.POSITIVE_INFINITY)).toBe(0.5);
  });
});

describe('splitPercent', () => {
  it('rounds to whole percent for aria', () => {
    expect(splitPercent(0.46)).toBe(46);
    expect(splitPercent(0.005)).toBe(1);
    expect(splitPercent(2)).toBe(100);
  });
});

describe('splitFromDrag', () => {
  it('moves by the pointer delta as a fraction of the width', () => {
    expect(splitFromDrag(0.5, 100, 1000)).toBeCloseTo(0.6);
    expect(splitFromDrag(0.5, -100, 1000)).toBeCloseTo(0.4);
  });

  it('clamps at the edges instead of running off', () => {
    expect(splitFromDrag(0.9, 500, 1000)).toBe(1);
    expect(splitFromDrag(0.1, -500, 1000)).toBe(0);
  });

  it('survives a zero-width surface', () => {
    expect(splitFromDrag(0.3, 40, 0)).toBe(0.3);
  });
});

describe('splitForKey', () => {
  it('nudges by one step, ten with shift', () => {
    expect(splitForKey(0.5, 'ArrowRight')).toBeCloseTo(0.5 + SPLIT_KEY_STEP);
    expect(splitForKey(0.5, 'ArrowLeft')).toBeCloseTo(0.5 - SPLIT_KEY_STEP);
    expect(splitForKey(0.5, 'ArrowRight', true)).toBeCloseTo(0.5 + SPLIT_KEY_STEP_LARGE);
  });

  it('jumps to the extremes', () => {
    expect(splitForKey(0.3, 'Home')).toBe(0);
    expect(splitForKey(0.3, 'End')).toBe(1);
  });

  it('clamps rather than overshooting', () => {
    expect(splitForKey(1, 'ArrowRight')).toBe(1);
    expect(splitForKey(0, 'ArrowLeft')).toBe(0);
  });

  it('ignores keys it does not own', () => {
    expect(splitForKey(0.5, 'a')).toBeNull();
    expect(splitForKey(0.5, 'ArrowUp')).toBeNull();
  });
});

describe('splitForDigit', () => {
  it('snaps 1 / 2 / 3 to original, centre, output', () => {
    expect(splitForDigit('Digit1')).toBe(0);
    expect(splitForDigit('Digit2')).toBe(0.5);
    expect(splitForDigit('Digit3')).toBe(1);
    expect(splitForDigit('Numpad3')).toBe(1);
  });

  it('ignores everything else', () => {
    expect(splitForDigit('Digit4')).toBeNull();
    expect(splitForDigit('KeyA')).toBeNull();
  });
});

describe('isTypingTarget', () => {
  it('is false without a DOM', () => {
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('zoom', () => {
  it('steps by 1.25 in each direction, reversibly', () => {
    expect(zoomInScale(1)).toBeCloseTo(ZOOM_STEP);
    expect(zoomOutScale(1)).toBeCloseTo(1 / ZOOM_STEP);
    expect(zoomOutScale(zoomInScale(3))).toBeCloseTo(3);
  });

  it('formats whole percents above 10%, one decimal below', () => {
    expect(formatZoomPercent(1)).toBe('100');
    expect(formatZoomPercent(0.3333)).toBe('33');
    expect(formatZoomPercent(0.024)).toBe('2.4');
    expect(formatZoomPercent(12)).toBe('1200');
  });

  it('never formats a broken scale', () => {
    expect(formatZoomPercent(0)).toBe('100');
    expect(formatZoomPercent(Number.NaN)).toBe('100');
  });

  it('parses what a user might type', () => {
    expect(parseZoomScale('250')).toBeCloseTo(2.5);
    expect(parseZoomScale(' 80 % ')).toBeCloseTo(0.8);
    expect(parseZoomScale('12.5')).toBeCloseTo(0.125);
  });

  it('rejects what it cannot use', () => {
    expect(parseZoomScale('')).toBeNull();
    expect(parseZoomScale('abc')).toBeNull();
    expect(parseZoomScale('0')).toBeNull();
    expect(parseZoomScale('-40')).toBeNull();
  });
});

describe('coordinate mapping', () => {
  it('places a centred, unzoomed image', () => {
    expect(contentOrigin(centred)).toEqual({ x: 200, y: 150 });
    expect(toViewportPointIn(centred, 400, 300, { x: 0, y: 0 })).toEqual({ x: 200, y: 150 });
    expect(toViewportPointIn(centred, 400, 300, { x: 400, y: 300 })).toEqual({ x: 600, y: 450 });
  });

  it('follows the pan/zoom transform', () => {
    const zoomed: RevealLayout = { ...centred, x: -40, y: 20, scale: 2 };
    // Origin = layout centre + translation; the scale then multiplies out.
    expect(contentOrigin(zoomed)).toEqual({ x: 160, y: 170 });
    expect(toViewportPointIn(zoomed, 400, 300, { x: 100, y: 50 })).toEqual({ x: 360, y: 270 });
  });

  it('rescales when image space is bigger than the rendered box', () => {
    // 4000×3000 source letterboxed into the 400×300 reference box.
    expect(toViewportPointIn(centred, 4000, 3000, { x: 2000, y: 1500 })).toEqual({
      x: 400,
      y: 300,
    });
  });

  it('inverts exactly — the crop tool round-trips through both', () => {
    const layout: RevealLayout = {
      containerWidth: 1024,
      containerHeight: 640,
      contentWidth: 512,
      contentHeight: 384,
      x: 37,
      y: -19,
      scale: 1.75,
    };
    const point = { x: 123.5, y: 456.25 };
    const viewport = toViewportPointIn(layout, 2048, 1536, point);
    const back = toImagePointIn(layout, 2048, 1536, viewport);
    expect(back.x).toBeCloseTo(point.x, 6);
    expect(back.y).toBeCloseTo(point.y, 6);
  });

  it('does not divide by zero before the first measurement', () => {
    const empty: RevealLayout = {
      containerWidth: 0,
      containerHeight: 0,
      contentWidth: 0,
      contentHeight: 0,
      x: 0,
      y: 0,
      scale: 0,
    };
    expect(toImagePointIn(empty, 0, 0, { x: 10, y: 10 })).toEqual({ x: 0, y: 0 });
    expect(toViewportPointIn(empty, 0, 0, { x: 10, y: 10 })).toEqual({ x: 0, y: 0 });
  });
});
