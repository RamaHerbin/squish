/**
 * Pure geometry for the crop tool: clamping, moving, resizing-by-handle and
 * aspect-ratio snapping of a {@link CropRect} inside an image's bounds.
 *
 * Everything here operates in *image space* — the same pixel space
 * `CropRect` is defined in (i.e. the rotated source, pre-resize). None of it
 * touches pixels, the DOM, or `../state` / `../compare` — `CropOverlay.svelte`
 * is the only consumer, and it supplies image-space points via the
 * `toImagePoint` prop it receives from its parent.
 *
 * Dependency-free: only imports types from `../contracts`.
 */

import type { CropRect, ImageDimensions } from '../contracts';

/** Smallest crop side, in image pixels. Prevents degenerate 0×N rects. */
export const MIN_CROP_SIZE = 8;

/** One of the 8 drag handles around a crop rect, compass-style. */
export type CropHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

/** Render/hit-test order; also the order `CropOverlay` iterates to lay out handles. */
export const CROP_HANDLES: readonly CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const HANDLE_CURSORS: Readonly<Record<CropHandle, string>> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

/** CSS `cursor` value to show while hovering/dragging a given handle. */
export function cursorForHandle(handle: CropHandle): string {
  return HANDLE_CURSORS[handle];
}

export interface AspectPreset {
  readonly label: string;
  /** width / height, or `null` for a freeform crop. */
  readonly ratio: number | null;
}

export const ASPECT_PRESETS: readonly AspectPreset[] = [
  { label: 'Free', ratio: null },
  { label: '1:1', ratio: 1 },
  { label: '16:9', ratio: 16 / 9 },
  { label: '4:3', ratio: 4 / 3 },
];

/** A point in CSS pixels, relative to `CropOverlay`'s own root element's top-left corner. */
export interface ViewportPoint {
  x: number;
  y: number;
}

/** A point in image pixels — the same space {@link CropRect} is defined in. */
export interface ImagePoint {
  x: number;
  y: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** A crop rect covering the whole image. */
export function fullImageCrop(bounds: ImageDimensions): CropRect {
  return { x: 0, y: 0, width: bounds.width, height: bounds.height };
}

/**
 * Round to integers and clamp fully inside `bounds`, enforcing
 * {@link MIN_CROP_SIZE} (shrunk to fit if the image itself is smaller than
 * that). Always returns a valid, in-bounds rect — safe to call on untrusted
 * or stale input.
 */
export function clampCropRect(rect: CropRect, bounds: ImageDimensions): CropRect {
  const boundW = Math.max(1, Math.round(bounds.width));
  const boundH = Math.max(1, Math.round(bounds.height));
  const minW = Math.min(MIN_CROP_SIZE, boundW);
  const minH = Math.min(MIN_CROP_SIZE, boundH);

  const width = clamp(Math.round(rect.width), minW, boundW);
  const height = clamp(Math.round(rect.height), minH, boundH);
  const x = clamp(Math.round(rect.x), 0, boundW - width);
  const y = clamp(Math.round(rect.y), 0, boundH - height);
  return { x, y, width, height };
}

/** Translate a rect by `(dx, dy)`, clamped so it stays fully inside `bounds`. */
export function moveCropRect(
  rect: CropRect,
  dx: number,
  dy: number,
  bounds: ImageDimensions,
): CropRect {
  const x = clamp(rect.x + dx, 0, Math.max(0, bounds.width - rect.width));
  const y = clamp(rect.y + dy, 0, Math.max(0, bounds.height - rect.height));
  return { x, y, width: rect.width, height: rect.height };
}

/**
 * Re-fit `rect` to `ratio` (width / height), keeping its centre point fixed
 * where possible. `ratio: null` is a no-op (aside from clamping). The
 * returned rect never exceeds the image bounds.
 */
export function applyAspect(
  rect: CropRect,
  ratio: number | null,
  bounds: ImageDimensions,
): CropRect {
  if (ratio === null) return clampCropRect(rect, bounds);

  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;

  // Largest rect of this ratio that fits inside the image at all.
  let maxW = bounds.width;
  let maxH = maxW / ratio;
  if (maxH > bounds.height) {
    maxH = bounds.height;
    maxW = maxH * ratio;
  }

  // Stay close to the current selection's footprint rather than jumping to
  // full-image size, but never exceed what actually fits.
  const preferredW = Math.max(rect.width, rect.height * ratio);
  const width = Math.min(maxW, preferredW);
  const height = width / ratio;

  return clampCropRect({ x: cx - width / 2, y: cy - height / 2, width, height }, bounds);
}

/**
 * Compute the rect that results from dragging `handle` so its edge(s) track
 * `pointer` (an image-space point). Enforces {@link MIN_CROP_SIZE}, keeps the
 * rect inside `bounds`, and — when `ratio` is not `null` — keeps
 * width / height locked to it, anchored at the edge(s) not being dragged.
 */
export function resizeCropRect(
  rect: CropRect,
  handle: CropHandle,
  pointer: ImagePoint,
  bounds: ImageDimensions,
  ratio: number | null,
): CropRect {
  const minW = Math.min(MIN_CROP_SIZE, bounds.width);
  const minH = Math.min(MIN_CROP_SIZE, bounds.height);

  const affectsTop = handle === 'n' || handle === 'ne' || handle === 'nw';
  const affectsBottom = handle === 's' || handle === 'se' || handle === 'sw';
  const affectsLeft = handle === 'w' || handle === 'nw' || handle === 'sw';
  const affectsRight = handle === 'e' || handle === 'ne' || handle === 'se';

  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;

  if (affectsLeft) left = clamp(pointer.x, 0, right - minW);
  if (affectsRight) right = clamp(pointer.x, left + minW, bounds.width);
  if (affectsTop) top = clamp(pointer.y, 0, bottom - minH);
  if (affectsBottom) bottom = clamp(pointer.y, top + minH, bounds.height);

  let width = right - left;
  let height = bottom - top;

  if (ratio !== null) {
    const horizontal = affectsLeft || affectsRight;
    const vertical = affectsTop || affectsBottom;

    if (horizontal && vertical) {
      // Corner handle: derive height from the new width, anchored at the
      // fixed opposite corner.
      height = width / ratio;
      if (affectsTop) top = bottom - height;
      else bottom = top + height;
    } else if (horizontal) {
      // Edge handle: keep the vertical centre fixed.
      const cy = (top + bottom) / 2;
      height = width / ratio;
      top = cy - height / 2;
      bottom = cy + height / 2;
    } else {
      // Edge handle: keep the horizontal centre fixed.
      const cx = (left + right) / 2;
      width = height * ratio;
      left = cx - width / 2;
      right = cx + width / 2;
    }

    // If that pushed us outside the image, scale back down (keeping the
    // ratio) until it fits again.
    if (left < 0 || right > bounds.width || top < 0 || bottom > bounds.height) {
      const scale = Math.min(bounds.width / width, bounds.height / height, 1);
      width *= scale;
      height *= scale;
      left = clamp(left, 0, bounds.width - width);
      top = clamp(top, 0, bounds.height - height);
      right = left + width;
      bottom = top + height;
    }
  }

  return clampCropRect({ x: left, y: top, width, height }, bounds);
}
