/**
 * Pan / zoom engine, ported from Squoosh's `<pinch-zoom>` custom element.
 *
 * Differences from the original:
 *
 * - **Raw pointer events** instead of `pointer-tracker`. Pointers are tracked in
 *   a `Map<pointerId, point>`; move/up listeners live on `window` rather than
 *   using `setPointerCapture`, which is what made Squoosh's event retargeting
 *   fall over on iOS Safari (webkit bug 220196). Because the moves are global,
 *   a finger that starts on one half of the split and travels onto the other
 *   half keeps feeding the same controller.
 * - **Closed-form transform maths** instead of `SVGMatrix`/`DOMMatrix`. Every
 *   transform here is `translate(x, y) scale(s)` with `transform-origin: 0 0`,
 *   i.e. `p → s·p + t`, so the whole matrix chain collapses to two additions
 *   (see {@link composeTransform}). That removes a per-`pointermove` matrix
 *   allocation and — the reason it matters here — makes the maths unit
 *   testable under jsdom, which ships no `DOMMatrix`.
 *
 * The controller owns no framework state: it writes `--x` / `--y` / `--scale`
 * onto the container element and calls `onChange`. `PinchZoom.svelte` supplies
 * the DOM, `CompareView.svelte` supplies the mirroring between the two sides.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** The bits of a `PointerEvent`/`Touch` this module cares about. */
export interface PinchZoomPoint {
  clientX: number;
  clientY: number;
}

/** `translate(x, y) scale(scale)`, applied with `transform-origin: 0 0`. */
export interface PinchZoomTransform {
  x: number;
  y: number;
  scale: number;
}

export interface SetTransformOptions extends Partial<PinchZoomTransform> {
  /**
   * Stop the content being flung entirely outside the container. Default true.
   * The mirrored (right-hand) side passes `false`: its transform is dictated by
   * the left side and must not drift away from it.
   */
  checkBounds?: boolean;
}

export interface ApplyChangeOptions {
  panX?: number;
  panY?: number;
  /** Zoom focus, in CSS px measured from the *rendered* content's top-left. */
  originX?: number;
  originY?: number;
  scaleDiff?: number;
  checkBounds?: boolean;
}

/** Which box a {@link ScaleToOptions} origin is measured against. */
export type ScaleOriginBox = 'container' | 'content';

export interface ScaleToOptions {
  /** Number of CSS px, or a percentage string such as `'50%'`. */
  originX?: number | string;
  originY?: number | string;
  /** Default `'container'` — what the zoom buttons want. */
  relativeTo?: ScaleOriginBox;
  checkBounds?: boolean;
}

export interface PinchZoomOptions {
  minScale?: number;
  maxScale?: number;
  /** When false the controller never binds input listeners. Default true. */
  interactive?: boolean;
  onChange?: (transform: PinchZoomTransform) => void;
}

export interface FitOptions {
  /** Never zoom past this when fitting. Default 1 (no upscaling). */
  maxScale?: number;
  /** Inset, in CSS px, kept between the content and the container edges. */
  padding?: number;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

export const DEFAULT_MIN_SCALE = 0.02;
export const DEFAULT_MAX_SCALE = 64;

/** Firefox reports `deltaMode: 1` (lines) for some mice. */
export const WHEEL_LINE_HEIGHT = 15;

/** Wheel divisor: trackpad pinch (`ctrlKey`) is far more sensitive. */
const WHEEL_PIXEL_DIVISOR = 300;
const WHEEL_PINCH_DIVISOR = 100;

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function getDistance(a: PinchZoomPoint, b?: PinchZoomPoint): number {
  if (!b) return 0;
  return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
}

export function getMidpoint(a: PinchZoomPoint, b?: PinchZoomPoint): PinchZoomPoint {
  if (!b) return { clientX: a.clientX, clientY: a.clientY };
  return {
    clientX: (a.clientX + b.clientX) / 2,
    clientY: (a.clientY + b.clientY) / 2,
  };
}

/** `'50%'` → half of `max`; a number passes straight through. */
export function resolveOrigin(value: number | string, max: number): number {
  if (typeof value === 'number') return value;
  const trimmed = value.trim();
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return 0;
  return trimmed.endsWith('%') ? (max * parsed) / 100 : parsed;
}

/**
 * The transform after panning by `pan` and scaling by `scaleDiff` about
 * `origin`.
 *
 * Equivalent to Squoosh's matrix chain
 * `T(pan)·T(origin)·T(x,y)·S(diff)·T(-origin)·S(scale)`, expanded: a transform
 * `p → s·p + t` composes as `(s₁·s₂, s₁·t₂ + t₁)`, and folding the chain gives
 * `t' = t + pan + origin·(1 − diff)` and `s' = s·diff`.
 */
export function composeTransform(
  current: PinchZoomTransform,
  change: Omit<ApplyChangeOptions, 'checkBounds'>,
): PinchZoomTransform {
  const { panX = 0, panY = 0, originX = 0, originY = 0, scaleDiff = 1 } = change;
  return {
    x: current.x + panX + originX * (1 - scaleDiff),
    y: current.y + panY + originY * (1 - scaleDiff),
    scale: current.scale * scaleDiff,
  };
}

/** Rectangle of the rendered content, relative to the container's top-left. */
export interface ContentBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Nudge a desired transform back until at least one edge of the content is
 * still inside the container — you can push the image off-centre, never off
 * screen.
 *
 * `content` is the box as currently rendered (i.e. already under `current`);
 * moving to `desired` maps a container-space point `p` to
 * `k·(p − current.t) + desired.t` where `k = desired.scale / current.scale`.
 */
export function correctForBounds(
  desired: PinchZoomTransform,
  current: PinchZoomTransform,
  container: { width: number; height: number },
  content: ContentBox,
): { x: number; y: number } {
  let { x, y } = desired;
  if (current.scale === 0) return { x, y };

  const k = desired.scale / current.scale;
  const left = k * (content.left - current.x) + desired.x;
  const top = k * (content.top - current.y) + desired.y;
  const right = left + k * content.width;
  const bottom = top + k * content.height;

  if (left > container.width) x += container.width - left;
  else if (right < 0) x += -right;

  if (top > container.height) y += container.height - top;
  else if (bottom < 0) y += -bottom;

  return { x, y };
}

/**
 * Translation that keeps content of size `width × height` centred in a
 * flex-centred container at a given `scale`.
 *
 * The content is laid out centred at scale 1 and scaled about its own top-left,
 * so re-centring only needs `size · (1 − scale) / 2` — no container measurement.
 */
export function centeredTranslation(size: number, scale: number): number {
  return (size * (1 - scale)) / 2;
}

/* -------------------------------------------------------------------------- */
/* Controller                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Pan/zoom controller for one element.
 *
 * ```ts
 * const zoom = new PinchZoomController({ onChange: (t) => (scale = t.scale) });
 * zoom.attach(containerEl, contentEl); // PinchZoom.svelte does this for you
 * ```
 */
export class PinchZoomController {
  #container: HTMLElement | undefined;
  #content: HTMLElement | undefined;

  #x = 0;
  #y = 0;
  #scale = 1;

  #minScale: number;
  #maxScale: number;
  #interactive: boolean;
  #onChange: ((transform: PinchZoomTransform) => void) | undefined;

  #pointers = new Map<number, PinchZoomPoint>();
  #trackingPointers = false;
  /** A `fit()` that arrived before the DOM did; replayed on {@link attach}. */
  #pendingFit: FitOptions | undefined;

  constructor(options: PinchZoomOptions = {}) {
    this.#minScale = options.minScale ?? DEFAULT_MIN_SCALE;
    this.#maxScale = options.maxScale ?? DEFAULT_MAX_SCALE;
    this.#interactive = options.interactive ?? true;
    this.#onChange = options.onChange;
  }

  /* ---------------------------------------------------------------------- */
  /* Wiring                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Bind to a container (the clipping viewport, and the element the CSS custom
   * properties are written to) and the single element it transforms.
   */
  attach(container: HTMLElement, content: HTMLElement): void {
    if (this.#container === container && this.#content === content) return;
    this.detach();
    this.#container = container;
    this.#content = content;
    this.#writeStyles();
    this.#bindInput();

    // The owning component may have asked to fit before its child rendered.
    if (this.#pendingFit) {
      const options = this.#pendingFit;
      this.#pendingFit = undefined;
      this.fit(options);
    }
  }

  detach(): void {
    this.#unbindInput();
    this.#releasePointers();
    this.#container = undefined;
    this.#content = undefined;
  }

  /** Alias for {@link PinchZoomController.detach}, for symmetry with the rest of the app. */
  dispose(): void {
    this.detach();
  }

  /** The container element — what retargeted events must be dispatched at. */
  get element(): HTMLElement | undefined {
    return this.#container;
  }

  get contentElement(): HTMLElement | undefined {
    return this.#content;
  }

  get interactive(): boolean {
    return this.#interactive;
  }

  set interactive(value: boolean) {
    if (this.#interactive === value) return;
    this.#interactive = value;
    if (value) this.#bindInput();
    else {
      this.#unbindInput();
      this.#releasePointers();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Transform                                                               */
  /* ---------------------------------------------------------------------- */

  get x(): number {
    return this.#x;
  }

  get y(): number {
    return this.#y;
  }

  get scale(): number {
    return this.#scale;
  }

  get minScale(): number {
    return this.#minScale;
  }

  get maxScale(): number {
    return this.#maxScale;
  }

  get transform(): PinchZoomTransform {
    return { x: this.#x, y: this.#y, scale: this.#scale };
  }

  /** Absolute transform update, bounds-checked unless told otherwise. */
  setTransform(options: SetTransformOptions = {}): void {
    const { checkBounds = true } = options;
    const scale = options.scale ?? this.#scale;
    let x = options.x ?? this.#x;
    let y = options.y ?? this.#y;

    const container = this.#container;
    const content = this.#content;

    if (checkBounds && container && content) {
      const containerRect = container.getBoundingClientRect();
      // Zero-sized container: disconnected or display:none. Take the values and
      // let the next interaction (which has layout) correct them.
      if (containerRect.width > 0 && containerRect.height > 0) {
        const contentRect = content.getBoundingClientRect();
        const corrected = correctForBounds(
          { x, y, scale },
          this.transform,
          { width: containerRect.width, height: containerRect.height },
          {
            left: contentRect.left - containerRect.left,
            top: contentRect.top - containerRect.top,
            width: contentRect.width,
            height: contentRect.height,
          },
        );
        x = corrected.x;
        y = corrected.y;
      }
    }

    this.#update(x, y, scale);
  }

  /** Relative change: pan, then zoom by `scaleDiff` about an origin. */
  applyChange(options: ApplyChangeOptions = {}): void {
    const { scaleDiff = 1, checkBounds = true, ...rest } = options;
    // Clamp the *target* scale rather than rejecting the whole gesture, so a
    // pinch that overshoots the limit still pans and simply stops zooming.
    const limited = clamp(this.#scale * scaleDiff, this.#minScale, this.#maxScale);
    const effectiveDiff = this.#scale === 0 ? 1 : limited / this.#scale;
    const next = composeTransform(this.transform, { ...rest, scaleDiff: effectiveDiff });
    this.setTransform({ ...next, checkBounds });
  }

  /** Zoom to an absolute scale, holding a chosen point still. */
  scaleTo(scale: number, options: ScaleToOptions = {}): void {
    const { originX = 0, originY = 0, relativeTo = 'container', checkBounds = true } = options;
    const container = this.#container;
    const content = this.#content;
    const target = clamp(scale, this.#minScale, this.#maxScale);

    if (!container || !content) {
      this.setTransform({ scale: target, checkBounds });
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const box = relativeTo === 'content' ? contentRect : containerRect;

    // applyChange wants the origin measured from the rendered content's
    // top-left, so translate whichever box was asked for into that space.
    const offsetX = relativeTo === 'content' ? 0 : containerRect.left - contentRect.left;
    const offsetY = relativeTo === 'content' ? 0 : containerRect.top - contentRect.top;

    this.applyChange({
      originX: resolveOrigin(originX, box.width) + offsetX,
      originY: resolveOrigin(originY, box.height) + offsetY,
      scaleDiff: this.#scale === 0 ? 1 : target / this.#scale,
      checkBounds,
    });
  }

  /** Back to 1:1, centred (the container flex-centres the content at scale 1). */
  reset(): void {
    this.setTransform({ x: 0, y: 0, scale: 1, checkBounds: false });
  }

  /** Scale the content down (never up, by default) until it fits, and centre it. */
  fit(options: FitOptions = {}): void {
    const container = this.#container;
    const content = this.#content;
    if (!container || !content) {
      this.#pendingFit = options;
      return;
    }

    const { padding = 0, maxScale = 1 } = options;
    const availableWidth = container.clientWidth - padding * 2;
    const availableHeight = container.clientHeight - padding * 2;
    // offsetWidth/Height are layout sizes: unaffected by the current transform.
    const width = content.offsetWidth;
    const height = content.offsetHeight;
    if (availableWidth <= 0 || availableHeight <= 0 || width <= 0 || height <= 0) return;

    this.#pendingFit = undefined;

    const scale = clamp(
      Math.min(availableWidth / width, availableHeight / height, maxScale),
      this.#minScale,
      this.#maxScale,
    );

    this.setTransform({
      scale,
      x: centeredTranslation(width, scale),
      y: centeredTranslation(height, scale),
      checkBounds: false,
    });
  }

  /**
   * Copy another controller's transform verbatim — how the right-hand side of
   * the compare view follows the left.
   */
  mirror(other: PinchZoomController): void {
    this.setTransform({ ...other.transform, checkBounds: false });
  }

  /**
   * Keep the content visually centred when the source pixels change size (a
   * 90° rotation, say). Ported from Squoosh's `componentDidUpdate`, generalised
   * to any size change.
   */
  recenterForContentSizeChange(
    oldWidth: number,
    oldHeight: number,
    newWidth: number,
    newHeight: number,
  ): void {
    if (this.#scale === 1) return;
    this.setTransform({
      x: this.#x + centeredTranslation(newWidth - oldWidth, this.#scale),
      y: this.#y + centeredTranslation(newHeight - oldHeight, this.#scale),
      checkBounds: false,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  #update(x: number, y: number, scale: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) return;
    const nextScale = clamp(scale, this.#minScale, this.#maxScale);
    if (x === this.#x && y === this.#y && nextScale === this.#scale) return;

    this.#x = x;
    this.#y = y;
    this.#scale = nextScale;
    this.#writeStyles();
    this.#onChange?.(this.transform);
  }

  #writeStyles(): void {
    const el = this.#container;
    if (!el) return;
    el.style.setProperty('--x', `${this.#x}px`);
    el.style.setProperty('--y', `${this.#y}px`);
    el.style.setProperty('--scale', `${this.#scale}`);
  }

  #bindInput(): void {
    const el = this.#container;
    if (!el || !this.#interactive) return;
    el.addEventListener('pointerdown', this.#onPointerDown);
    el.addEventListener('wheel', this.#onWheel, { passive: false });
  }

  #unbindInput(): void {
    const el = this.#container;
    if (!el) return;
    el.removeEventListener('pointerdown', this.#onPointerDown);
    el.removeEventListener('wheel', this.#onWheel);
  }

  #trackPointers(): void {
    if (this.#trackingPointers || typeof window === 'undefined') return;
    this.#trackingPointers = true;
    window.addEventListener('pointermove', this.#onPointerMove);
    window.addEventListener('pointerup', this.#onPointerEnd);
    window.addEventListener('pointercancel', this.#onPointerEnd);
  }

  #releasePointers(): void {
    this.#pointers.clear();
    if (!this.#trackingPointers || typeof window === 'undefined') return;
    this.#trackingPointers = false;
    window.removeEventListener('pointermove', this.#onPointerMove);
    window.removeEventListener('pointerup', this.#onPointerEnd);
    window.removeEventListener('pointercancel', this.#onPointerEnd);
  }

  #onPointerDown = (event: PointerEvent): void => {
    if (!this.#interactive || !this.#content) return;
    // Right/middle mouse buttons keep their native behaviour.
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // Two pointers is all a pinch needs; ignore extra fingers.
    if (this.#pointers.size >= 2 || this.#pointers.has(event.pointerId)) return;

    // Suppresses text selection, native drag, and the compat mouse events.
    if (event.cancelable) event.preventDefault();

    this.#pointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    // Moves are tracked on window, not via setPointerCapture: the pointer may
    // wander onto the other half of the split, and captured pointers plus
    // retargeted events is exactly the combination Safari mishandles.
    this.#trackPointers();
  };

  #onPointerMove = (event: PointerEvent): void => {
    const tracked = this.#pointers.get(event.pointerId);
    if (!tracked) return;

    const previous = [...this.#pointers.values()].map((point) => ({ ...point }));
    tracked.clientX = event.clientX;
    tracked.clientY = event.clientY;
    const current = [...this.#pointers.values()];

    this.#applyPointerChange(previous, current);
  };

  #onPointerEnd = (event: PointerEvent): void => {
    if (!this.#pointers.delete(event.pointerId)) return;
    if (this.#pointers.size === 0) this.#releasePointers();
  };

  #applyPointerChange(previous: PinchZoomPoint[], current: PinchZoomPoint[]): void {
    const content = this.#content;
    const prevA = previous[0];
    const currA = current[0];
    if (!content || !prevA || !currA) return;

    const rect = content.getBoundingClientRect();
    const prevMid = getMidpoint(prevA, previous[1]);
    const currMid = getMidpoint(currA, current[1]);

    const prevDistance = getDistance(prevA, previous[1]);
    const nextDistance = getDistance(currA, current[1]);
    const scaleDiff = prevDistance > 0 ? nextDistance / prevDistance : 1;

    this.applyChange({
      originX: prevMid.clientX - rect.left,
      originY: prevMid.clientY - rect.top,
      scaleDiff,
      panX: currMid.clientX - prevMid.clientX,
      panY: currMid.clientY - prevMid.clientY,
    });
  }

  #onWheel = (event: WheelEvent): void => {
    const content = this.#content;
    if (!content || !this.#interactive) return;
    if (event.cancelable) event.preventDefault();

    let { deltaY } = event;
    if (event.deltaMode === 1) deltaY *= WHEEL_LINE_HEIGHT;
    if (deltaY === 0) return;

    // ctrlKey is set by trackpad pinch gestures.
    const divisor = event.ctrlKey ? WHEEL_PINCH_DIVISOR : WHEEL_PIXEL_DIVISOR;
    // Clamped so one violent scroll cannot invert or annihilate the ratio, and
    // symmetric so zoom-in then zoom-out by the same delta is a round trip.
    const ratio = 1 - Math.min(Math.abs(deltaY), divisor * 0.9) / divisor;
    const zoomingOut = deltaY > 0;
    const scaleDiff = zoomingOut ? ratio : 1 / ratio;

    const rect = content.getBoundingClientRect();
    this.applyChange({
      scaleDiff,
      originX: event.clientX - rect.left,
      originY: event.clientY - rect.top,
    });
  };
}

/** Convenience factory, for `const zoom = createPinchZoom({ onChange })`. */
export function createPinchZoom(options?: PinchZoomOptions): PinchZoomController {
  return new PinchZoomController(options);
}
