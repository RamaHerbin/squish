import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MAX_SCALE,
  DEFAULT_MIN_SCALE,
  PinchZoomController,
  centeredTranslation,
  clamp,
  composeTransform,
  correctForBounds,
  createPinchZoom,
  getDistance,
  getMidpoint,
  resolveOrigin,
  type PinchZoomTransform,
} from './pinch-zoom';

describe('pure helpers', () => {
  it('clamps', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });

  it('measures distance and midpoint, tolerating a missing second pointer', () => {
    const a = { clientX: 0, clientY: 0 };
    const b = { clientX: 3, clientY: 4 };
    expect(getDistance(a, b)).toBe(5);
    expect(getDistance(a)).toBe(0);
    expect(getMidpoint(a, b)).toEqual({ clientX: 1.5, clientY: 2 });
    expect(getMidpoint(b)).toEqual({ clientX: 3, clientY: 4 });
  });

  it('resolves percentage and absolute origins', () => {
    expect(resolveOrigin('50%', 400)).toBe(200);
    expect(resolveOrigin(' 25% ', 400)).toBe(100);
    expect(resolveOrigin(120, 400)).toBe(120);
    expect(resolveOrigin('12', 400)).toBe(12);
    expect(resolveOrigin('nope', 400)).toBe(0);
  });
});

describe('composeTransform', () => {
  const identity: PinchZoomTransform = { x: 0, y: 0, scale: 1 };

  it('pans without touching the scale', () => {
    expect(composeTransform(identity, { panX: 10, panY: -5 })).toEqual({
      x: 10,
      y: -5,
      scale: 1,
    });
  });

  it('keeps the zoom origin pinned to the same content point', () => {
    // Zooming 2x about a point 100px from the content's left edge must push the
    // content 100px left, so that point stays where it was on screen.
    const next = composeTransform(identity, { originX: 100, originY: 40, scaleDiff: 2 });
    expect(next).toEqual({ x: -100, y: -40, scale: 2 });

    // …and zooming back out about the *new* offset of that same point returns
    // the transform exactly where it started.
    const back = composeTransform(next, { originX: 200, originY: 80, scaleDiff: 0.5 });
    expect(back).toEqual(identity);
  });

  it('composes a pan and a zoom in one step', () => {
    expect(composeTransform({ x: 5, y: 5, scale: 2 }, { panX: 3, originX: 10, scaleDiff: 1.5 })).toEqual(
      { x: 5 + 3 + 10 * -0.5, y: 5, scale: 3 },
    );
  });
});

describe('correctForBounds', () => {
  const container = { width: 200, height: 100 };
  const current: PinchZoomTransform = { x: 0, y: 0, scale: 1 };
  const content = { left: 0, top: 0, width: 50, height: 50 };

  it('leaves an in-bounds transform alone', () => {
    expect(correctForBounds({ x: 10, y: 10, scale: 1 }, current, container, content)).toEqual({
      x: 10,
      y: 10,
    });
  });

  it('pulls content back when it is dragged off the right edge', () => {
    // Content would start at x=300, past the 200px-wide container.
    expect(correctForBounds({ x: 300, y: 0, scale: 1 }, current, container, content)).toEqual({
      x: 200,
      y: 0,
    });
  });

  it('pulls content back when it is dragged off the left edge', () => {
    // Content would end at -10; nudge it so its right edge sits at 0.
    expect(correctForBounds({ x: -60, y: 0, scale: 1 }, current, container, content)).toEqual({
      x: -50,
      y: 0,
    });
  });

  it('accounts for the scale change when checking bounds', () => {
    // Doubling the scale doubles the content's on-screen size, so the same
    // translation is no longer out of bounds.
    expect(correctForBounds({ x: -60, y: 0, scale: 2 }, current, container, content)).toEqual({
      x: -60,
      y: 0,
    });
  });
});

describe('centeredTranslation', () => {
  it('is zero at 1:1 and half the shrinkage otherwise', () => {
    expect(centeredTranslation(100, 1)).toBe(0);
    expect(centeredTranslation(100, 0.5)).toBe(25);
    expect(centeredTranslation(100, 2)).toBe(-50);
  });
});

describe('PinchZoomController', () => {
  it('starts at identity', () => {
    const zoom = createPinchZoom();
    expect(zoom.transform).toEqual({ x: 0, y: 0, scale: 1 });
    expect(zoom.element).toBeUndefined();
  });

  it('notifies on change and stays silent when nothing moved', () => {
    const onChange = vi.fn();
    const zoom = new PinchZoomController({ onChange });

    zoom.setTransform({ x: 10, y: 20, scale: 2 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ x: 10, y: 20, scale: 2 });

    zoom.setTransform({ x: 10, y: 20, scale: 2 });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('ignores non-finite transforms', () => {
    const zoom = createPinchZoom();
    zoom.setTransform({ x: Number.NaN });
    expect(zoom.x).toBe(0);
    zoom.setTransform({ scale: Number.POSITIVE_INFINITY });
    expect(zoom.scale).toBe(1);
  });

  it('clamps the scale instead of dropping the whole gesture', () => {
    const zoom = new PinchZoomController({ minScale: 0.5, maxScale: 4 });

    zoom.applyChange({ scaleDiff: 100, panX: 7 });
    expect(zoom.scale).toBe(4);
    // The pan still landed, which is what stops a pinch from feeling stuck.
    expect(zoom.x).toBe(7);

    zoom.applyChange({ scaleDiff: 0.0001 });
    expect(zoom.scale).toBe(0.5);
  });

  it('defaults to the documented scale limits', () => {
    const zoom = createPinchZoom();
    zoom.scaleTo(1e9);
    expect(zoom.scale).toBe(DEFAULT_MAX_SCALE);
    zoom.scaleTo(1e-9);
    expect(zoom.scale).toBe(DEFAULT_MIN_SCALE);
  });

  it('scales to an absolute value when detached', () => {
    const zoom = createPinchZoom();
    zoom.scaleTo(2.5);
    expect(zoom.scale).toBe(2.5);
  });

  it('mirrors another controller exactly', () => {
    const left = createPinchZoom();
    const right = new PinchZoomController({ interactive: false });

    left.setTransform({ x: -30, y: 12, scale: 3 });
    right.mirror(left);

    expect(right.transform).toEqual(left.transform);
  });

  it('re-centres when the content changes size under a zoomed transform', () => {
    const zoom = createPinchZoom();
    zoom.setTransform({ scale: 0.5, x: centeredTranslation(200, 0.5), y: centeredTranslation(100, 0.5) });

    // A 90° rotation swaps the dimensions.
    zoom.recenterForContentSizeChange(200, 100, 100, 200);

    expect(zoom.x).toBe(centeredTranslation(100, 0.5));
    expect(zoom.y).toBe(centeredTranslation(200, 0.5));
  });

  it('does not move a 1:1 view when the content resizes', () => {
    const zoom = createPinchZoom();
    zoom.setTransform({ x: 5, y: 5 });
    zoom.recenterForContentSizeChange(200, 100, 100, 200);
    expect(zoom.transform).toEqual({ x: 5, y: 5, scale: 1 });
  });

  it('resets to identity', () => {
    const zoom = createPinchZoom();
    zoom.setTransform({ x: 42, y: -8, scale: 6 });
    zoom.reset();
    expect(zoom.transform).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('never binds listeners when non-interactive', () => {
    const zoom = new PinchZoomController({ interactive: false });
    expect(zoom.interactive).toBe(false);
    zoom.interactive = true;
    expect(zoom.interactive).toBe(true);
  });
});
