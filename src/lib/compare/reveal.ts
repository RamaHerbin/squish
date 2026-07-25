/**
 * The reveal-compare surface: constants, prop contracts and the pure maths
 * behind it.
 *
 * Everything here is framework-free and DOM-free so it can be unit tested in
 * plain node — the components in this directory hold no geometry of their own,
 * they only measure the DOM and hand the numbers to these functions.
 *
 * ## Coordinate spaces
 * Three, and only three:
 *  - **container** — CSS px from the top-left of the reveal surface (the same
 *    box `CropOverlay` measures against, since both fill the surface).
 *  - **content** — CSS px inside the transformed image box, before
 *    `translate(x, y) scale(s)`. Its size is the *reference image's* pixel
 *    size, which is why both halves of the split stay aligned when one side
 *    has been resized.
 *  - **image** — pixels of the image a `CropRect` is defined in (the rotated
 *    source, pre-resize). Usually identical to content space, hence the
 *    explicit `imageWidth`/`imageHeight` arguments rather than an assumption.
 *
 * The layout contract mirrors `PinchZoom.svelte`'s: the content is flex-centred
 * at scale 1 and scaled about its own top-left, so its rendered origin is
 * `(container − content) / 2 + translation` with no measurement of the content
 * itself.
 */

import type { CropRect } from '../contracts';
import type { EditState } from '../edit/edit.svelte';
import type { AccentName } from '../ui';

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Divider position on the 1440×900 comp: 46% of the surface. */
export const DEFAULT_REVEAL_SPLIT = 0.46;

/** …and 52% on the 390×844 mobile comp. */
export const COMPACT_REVEAL_SPLIT = 0.52;

/** Below this the surface switches to the mobile overlay treatment. */
export const REVEAL_COMPACT_QUERY = '(max-width: 640px)';

/** Arrow-key nudge of the divider, as a fraction of the surface width. */
export const SPLIT_KEY_STEP = 0.02;

/** …with Shift held. */
export const SPLIT_KEY_STEP_LARGE = 0.1;

/** Multiplier applied by the zoom pill's − / + segments. */
export const ZOOM_STEP = 1.25;

/* -------------------------------------------------------------------------- */
/* Points & layout                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A 2D point. Structurally identical to `edit/geometry`'s `ViewportPoint` and
 * `ImagePoint`, which is what lets the mapping functions below be handed
 * straight to `CropOverlay` without this module importing it.
 */
export interface RevealPoint {
  x: number;
  y: number;
}

/** Everything needed to place a point on the surface: measurement + transform. */
export interface RevealLayout {
  /** Surface size, CSS px. */
  containerWidth: number;
  containerHeight: number;
  /** Content box size at scale 1, CSS px — the reference image's dimensions. */
  contentWidth: number;
  contentHeight: number;
  /** Current pan/zoom, as written by `PinchZoomController`. */
  x: number;
  y: number;
  scale: number;
}

/** Rendered position of the content's own top-left, in container space. */
export function contentOrigin(layout: RevealLayout): RevealPoint {
  return {
    x: (layout.containerWidth - layout.contentWidth) / 2 + layout.x,
    y: (layout.containerHeight - layout.contentHeight) / 2 + layout.y,
  };
}

/** CSS px per image pixel, before the zoom scale is applied. */
function contentRatio(layout: RevealLayout, imageWidth: number, imageHeight: number): RevealPoint {
  return {
    x: imageWidth > 0 ? layout.contentWidth / imageWidth : 1,
    y: imageHeight > 0 ? layout.contentHeight / imageHeight : 1,
  };
}

/** Image-space point → container-space point. */
export function toViewportPointIn(
  layout: RevealLayout,
  imageWidth: number,
  imageHeight: number,
  point: RevealPoint,
): RevealPoint {
  const origin = contentOrigin(layout);
  const ratio = contentRatio(layout, imageWidth, imageHeight);
  return {
    x: origin.x + point.x * ratio.x * layout.scale,
    y: origin.y + point.y * ratio.y * layout.scale,
  };
}

/** Container-space point → image-space point. Inverse of {@link toViewportPointIn}. */
export function toImagePointIn(
  layout: RevealLayout,
  imageWidth: number,
  imageHeight: number,
  point: RevealPoint,
): RevealPoint {
  const origin = contentOrigin(layout);
  const ratio = contentRatio(layout, imageWidth, imageHeight);
  const denominatorX = ratio.x * layout.scale;
  const denominatorY = ratio.y * layout.scale;
  return {
    x: denominatorX === 0 ? 0 : (point.x - origin.x) / denominatorX,
    y: denominatorY === 0 ? 0 : (point.y - origin.y) / denominatorY,
  };
}

/* -------------------------------------------------------------------------- */
/* Divider                                                                     */
/* -------------------------------------------------------------------------- */

/** Clamp a divider fraction into 0–1. Non-finite input falls back to centre. */
export function clampSplit(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(Math.max(value, 0), 1);
}

/** Whole-percent form, for `aria-valuenow` and the CSS custom property. */
export function splitPercent(split: number): number {
  return Math.round(clampSplit(split) * 100);
}

/**
 * Divider position after dragging `deltaX` px from `startSplit`.
 *
 * Delta-based rather than absolute so grabbing the handle off-centre does not
 * make it jump, and width-relative so a resize mid-drag cannot skew it.
 */
export function splitFromDrag(startSplit: number, deltaX: number, width: number): number {
  if (width <= 0) return clampSplit(startSplit);
  return clampSplit(startSplit + deltaX / width);
}

/** Divider position after an arrow / Home / End press. `null` = key not ours. */
export function splitForKey(current: number, key: string, shiftKey = false): number | null {
  const step = shiftKey ? SPLIT_KEY_STEP_LARGE : SPLIT_KEY_STEP;
  switch (key) {
    case 'ArrowLeft':
      return clampSplit(current - step);
    case 'ArrowRight':
      return clampSplit(current + step);
    case 'Home':
      return 0;
    case 'End':
      return 1;
    default:
      return null;
  }
}

/** `1` / `2` / `3` snap the divider to fully-original / centre / fully-output. */
export function splitForDigit(code: string): number | null {
  switch (code) {
    case 'Digit1':
    case 'Numpad1':
      return 0;
    case 'Digit2':
    case 'Numpad2':
      return 0.5;
    case 'Digit3':
    case 'Numpad3':
      return 1;
    default:
      return null;
  }
}

/**
 * True when a keystroke belongs to a text field and the global shortcuts must
 * keep their hands off it. Safe to call outside a DOM (returns `false`).
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest('input, textarea, select') !== null;
}

/* -------------------------------------------------------------------------- */
/* Zoom                                                                        */
/* -------------------------------------------------------------------------- */

/** One press of the pill's `+`. */
export function zoomInScale(scale: number): number {
  return scale * ZOOM_STEP;
}

/** One press of the pill's `−`. */
export function zoomOutScale(scale: number): number {
  return scale / ZOOM_STEP;
}

/**
 * Scale → the text in the editable segment. Sub-10% keeps one decimal so
 * zooming out of a huge image still reads as a change.
 */
export function formatZoomPercent(scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0) return '100';
  const percent = scale * 100;
  return String(percent >= 10 ? Math.round(percent) : Math.round(percent * 10) / 10);
}

/** Typed text → scale. `null` when it is not a usable number. */
export function parseZoomScale(text: string): number | null {
  const percent = Number.parseFloat(text.replace('%', '').trim());
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return percent / 100;
}

/* -------------------------------------------------------------------------- */
/* Prop contracts                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `<AutoPill />` — the top-centre suggestion strip: blue `AUTO` segment,
 * message, then either a static "Applied" read-out or an action button.
 * Renders nothing unless {@link AutoPillProps.open} is true.
 */
export interface AutoPillProps {
  /** Hidden until this is true. Default `false`. */
  open?: boolean;
  /** The sentence in the middle. */
  message: string;
  /** Left segment text. Default `Auto`. */
  label?: string;
  /** Right segment text. Default `Applied`. */
  actionLabel?: string;
  /** Given, the right segment becomes a button. Omitted, it is a read-out. */
  onaction?: () => void;
  /** Left segment fill. Default `blue`. */
  accent?: AccentName | string;
  /** Announce changes to assistive tech. Default `true`. */
  live?: boolean;
  compact?: boolean;
  class?: string;
}

/**
 * `<ZoomPill />` — the bottom-centre viewport bar:
 * `− | 100% | + | FIT | 1:1` plus rotate and crop when those callbacks exist.
 *
 * It reports *absolute* target scales; who the zoom is anchored on is the
 * surface's business, not the pill's.
 */
export interface ZoomPillProps {
  /** Current zoom, `1` = 100%. */
  scale: number;
  /** Absolute target scale — from `−`, `+`, `1:1` or the editable field. */
  onzoom: (scale: number) => void;
  /** Fit the image to the surface. Segment hidden when omitted. */
  onfit?: () => void;
  /** Rotate 90° clockwise. Segment hidden when omitted. */
  onrotate?: () => void;
  /** Toggle crop mode. Segment hidden when omitted. */
  oncrop?: () => void;
  /** Paints the crop segment as active. */
  cropping?: boolean;
  /** Smaller segments for the 390px layout. */
  compact?: boolean;
  disabled?: boolean;
  class?: string;
}

/**
 * `<RevealCompare />` — the full-bleed image bed at the centre of the editor.
 *
 * One shared pan/zoom transform drives two stacked canvases; the output is
 * revealed to the right of a draggable divider. Pixels arrive as `ImageData`
 * and are blitted imperatively, never through the template.
 */
export interface RevealCompareProps {
  /** Side 0 pixels — the original. Falls back to {@link RevealCompareProps.source}. */
  original?: ImageData;
  /** Side 1 pixels — the encode being judged. */
  output?: ImageData;
  /**
   * Preprocessed pixels, used as the on-screen reference size for both
   * canvases. Defaults to whichever side has pixels.
   */
  source?: ImageData;
  /**
   * Anything that changes when a *new file* is opened (pass the `File`). A
   * change resets the view and fits; a change of `source` alone is treated as
   * a rotate/crop and only re-centres.
   */
  sourceKey?: unknown;

  /** Divider position, 0–1. Omit to let the component own it. */
  split?: number;
  /** Initial divider position when uncontrolled. Defaults per breakpoint. */
  defaultSplit?: number;
  /** Fires on every divider move, dragged or keyed. */
  onsplit?: (split: number) => void;

  /** Force the mobile treatment. Defaults to a `max-width: 640px` match. */
  compact?: boolean;

  /** `image-rendering: pixelated` on both canvases. */
  pixelated?: boolean;

  /** Card headings. Defaults `Original` / `Output`. */
  originalLabel?: string;
  outputLabel?: string;
  /** Big figure on the original card, e.g. `2.92 MB`. */
  originalSize?: string;
  /** Sub-line on the original card, e.g. `JPEG · 4032 × 3024`. */
  originalMeta?: string;
  /** Big figure on the output card, e.g. `390 kB`. */
  outputSize?: string;
  /** Delta beside it, e.g. `−87%`. */
  outputDelta?: string;
  /** Colour of that delta on the ink card. Default `yellow`. */
  outputDeltaTone?: AccentName | string;
  /** Sub-line on the output card, e.g. `AVIF · q52 · 4032 × 3024`. */
  outputMeta?: string;
  /** Hide both read-out cards. Default `true` (shown). */
  showInfo?: boolean;

  /** Auto-suggestion strip. Hidden unless `autoOpen`. */
  autoOpen?: boolean;
  autoMessage?: string;
  autoLabel?: string;
  autoActionLabel?: string;
  onauto?: () => void;

  /** Show the zoom pill. Default `true`. */
  showZoom?: boolean;
  /** Rotate 90°; the pill's rotate segment is hidden without it. */
  onrotate?: () => void;
  /**
   * Crop segment handler. Defaults to toggling
   * {@link RevealCompareProps.editState} when that is supplied.
   */
  oncrop?: () => void;
  /** Fires whenever the shared zoom changes. */
  onzoomchange?: (scale: number) => void;

  /** Crop-mode store, shared with whatever else toggles it. */
  editState?: EditState;
  /** Width of the space `crop` is defined in. Defaults to the reference width. */
  cropImageWidth?: number;
  cropImageHeight?: number;
  /** Existing crop, if any. */
  crop?: CropRect;
  onCropApply?: (rect: CropRect) => void;
  onCropCancel?: () => void;

  /** Mono caption shown on the bare bed while there are no pixels. */
  placeholder?: string;
  /** Bind the global `1` / `2` / `3` divider shortcuts. Default `true`. */
  shortcuts?: boolean;
  class?: string;
}
