<script lang="ts">
  /**
   * Crop tool overlay. Rendered by the parent *on top of* the compare view —
   * this component only fills whatever box it is placed in (`position:
   * absolute; inset: 0`); the parent owns sizing/positioning of that box.
   *
   * Coordinate contract (see the `toImagePoint` / `toViewportPoint` props):
   * this component works entirely in two spaces —
   *  - "viewport" space: CSS px relative to *this component's own root
   *    element's* top-left corner (i.e. `event.clientX/Y` minus that
   *    element's `getBoundingClientRect().left/top`).
   *  - "image" space: pixels of the rotated source, pre-resize — exactly the
   *    space `CropRect` (from `../contracts`) is defined in.
   * The parent supplies the mapping between them (it alone knows the
   * compare view's zoom/pan/letterboxing), as a pair of pure functions.
   *
   * Only depends on `../contracts` + `./geometry` + `./edit.svelte` — no
   * import from `../state` or `../compare`.
   */
  import { untrack } from 'svelte';

  import type { CropRect } from '../contracts';
  import type { EditState } from './edit.svelte';
  import {
    ASPECT_PRESETS,
    CROP_HANDLES,
    applyAspect,
    clampCropRect,
    cursorForHandle,
    fullImageCrop,
    moveCropRect,
    resizeCropRect,
    type CropHandle,
    type ImagePoint,
    type ViewportPoint,
  } from './geometry';

  interface Props {
    /** Shared with `EditBar` so the toolbar button and this overlay stay in sync. */
    editState: EditState;
    /** Width of the rotated source, in pixels. */
    imageWidth: number;
    /** Height of the rotated source, in pixels. */
    imageHeight: number;
    /** Existing crop (image space), if any. Undefined ⇒ start from the full image. */
    crop?: CropRect;
    /** Viewport point (this component's local space) → image-space point. */
    toImagePoint: (viewport: ViewportPoint) => ImagePoint;
    /** Image-space point → viewport point (this component's local space). */
    toViewportPoint: (image: ImagePoint) => ViewportPoint;
    /** Called with the final rect (already clamped) when the user applies. */
    onApply: (rect: CropRect) => void;
    /** Called when the user cancels — the caller should leave the crop as-is. */
    onCancel: () => void;
  }

  let { editState, imageWidth, imageHeight, crop, toImagePoint, toViewportPoint, onApply, onCancel }:
    Props = $props();

  const bounds = $derived({
    width: Math.max(1, Math.round(imageWidth)),
    height: Math.max(1, Math.round(imageHeight)),
  });

  let draft = $state<CropRect>({ x: 0, y: 0, width: 1, height: 1 });
  let aspect = $state<number | null>(null);
  let activeHandle = $state<CropHandle | 'move' | null>(null);
  let wasOpen = $state(false);
  let rootEl = $state<HTMLDivElement | undefined>(undefined);
  /** Drag-start snapshot for a move; plain (non-reactive) — handler-local only. */
  let moveOrigin: { pointer: ImagePoint; rect: CropRect } | null = null;

  // Re-seed the draft rect whenever crop mode is freshly entered (not on
  // every bounds/crop change — that would fight an in-progress drag).
  $effect(() => {
    const isOpen = editState.mode === 'cropping';
    const b = bounds;
    const initial = crop;
    if (isOpen && !untrack(() => wasOpen)) {
      draft = initial ? clampCropRect(initial, b) : fullImageCrop(b);
      aspect = null;
      rootEl?.focus();
    }
    wasOpen = isOpen;
  });

  const viewTopLeft = $derived(toViewportPoint({ x: draft.x, y: draft.y }));
  const viewBottomRight = $derived(
    toViewportPoint({ x: draft.x + draft.width, y: draft.y + draft.height }),
  );
  const vx = $derived(viewTopLeft.x);
  const vy = $derived(viewTopLeft.y);
  const vw = $derived(viewBottomRight.x - viewTopLeft.x);
  const vh = $derived(viewBottomRight.y - viewTopLeft.y);

  function viewportPointFromEvent(e: PointerEvent): ViewportPoint {
    const rect = rootEl?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  }

  function imagePointFromEvent(e: PointerEvent): ImagePoint {
    return toImagePoint(viewportPointFromEvent(e));
  }

  function capture(e: PointerEvent): void {
    const target = e.currentTarget;
    if (target instanceof Element) target.setPointerCapture(e.pointerId);
  }

  function release(e: PointerEvent): void {
    const target = e.currentTarget;
    if (target instanceof Element && target.hasPointerCapture(e.pointerId)) {
      target.releasePointerCapture(e.pointerId);
    }
  }

  function startMove(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    capture(e);
    activeHandle = 'move';
    moveOrigin = { pointer: imagePointFromEvent(e), rect: draft };
  }

  function startResize(e: PointerEvent, handle: CropHandle): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    capture(e);
    activeHandle = handle;
  }

  function onDragMove(e: PointerEvent): void {
    if (activeHandle === null) return;
    const point = imagePointFromEvent(e);
    if (activeHandle === 'move') {
      if (!moveOrigin) return;
      const dx = point.x - moveOrigin.pointer.x;
      const dy = point.y - moveOrigin.pointer.y;
      draft = moveCropRect(moveOrigin.rect, dx, dy, bounds);
    } else {
      draft = resizeCropRect(draft, activeHandle, point, bounds, aspect);
    }
  }

  function endDrag(e: PointerEvent): void {
    if (activeHandle === null) return;
    release(e);
    activeHandle = null;
    moveOrigin = null;
  }

  function selectAspect(): void {
    draft = applyAspect(draft, aspect, bounds);
  }

  function apply(): void {
    onApply(clampCropRect(draft, bounds));
    editState.exitCrop();
  }

  function cancel(): void {
    onCancel();
    editState.exitCrop();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      apply();
    }
  }
</script>

{#if editState.mode === 'cropping'}
  <div
    class="crop-overlay"
    bind:this={rootEl}
    tabindex="-1"
    role="dialog"
    aria-label="Crop image"
    onkeydown={onKeydown}
  >
    <div class="mask mask-top" style:height={`${vy}px`}></div>
    <div class="mask mask-bottom" style:top={`${vy + vh}px`}></div>
    <div
      class="mask mask-left"
      style:top={`${vy}px`}
      style:width={`${vx}px`}
      style:height={`${vh}px`}
    ></div>
    <div
      class="mask mask-right"
      style:top={`${vy}px`}
      style:left={`${vx + vw}px`}
      style:height={`${vh}px`}
    ></div>

    <div
      class="rect"
      style:left={`${vx}px`}
      style:top={`${vy}px`}
      style:width={`${vw}px`}
      style:height={`${vh}px`}
      onpointerdown={startMove}
      onpointermove={onDragMove}
      onpointerup={endDrag}
      onpointercancel={endDrag}
      role="presentation"
    >
      <div class="thirds" aria-hidden="true">
        <span class="line v v1"></span>
        <span class="line v v2"></span>
        <span class="line h h1"></span>
        <span class="line h h2"></span>
      </div>

      {#each CROP_HANDLES as handle (handle)}
        <button
          type="button"
          class="handle handle-{handle}"
          style:cursor={cursorForHandle(handle)}
          aria-label={`Resize crop from the ${handle} edge`}
          onpointerdown={(e) => startResize(e, handle)}
          onpointermove={onDragMove}
          onpointerup={endDrag}
          onpointercancel={endDrag}
        ></button>
      {/each}
    </div>

    <div class="toolbar">
      <label class="aspect-label">
        <span>Aspect</span>
        <select bind:value={aspect} onchange={selectAspect} aria-label="Aspect ratio">
          {#each ASPECT_PRESETS as preset (preset.label)}
            <option value={preset.ratio}>{preset.label}</option>
          {/each}
        </select>
      </label>
      <div class="spacer"></div>
      <button type="button" class="btn ghost" onclick={cancel}>Cancel</button>
      <button type="button" class="btn primary" onclick={apply}>Apply</button>
    </div>
  </div>
{/if}

<style>
  .crop-overlay {
    position: absolute;
    inset: 0;
    overflow: hidden;
    touch-action: none;
    outline: none;
    z-index: 10;
  }

  .mask {
    position: absolute;
    background: color-mix(in srgb, black 55%, transparent);
    pointer-events: none;
  }

  .mask-top {
    top: 0;
    left: 0;
    right: 0;
  }

  .mask-bottom {
    left: 0;
    right: 0;
    bottom: 0;
  }

  .mask-left {
    left: 0;
  }

  .mask-right {
    right: 0;
  }

  .rect {
    position: absolute;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.9);
    cursor: move;
    touch-action: none;
  }

  .thirds {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .line {
    position: absolute;
    background: rgba(255, 255, 255, 0.45);
  }

  .line.v {
    top: 0;
    bottom: 0;
    width: 1px;
  }

  .line.h {
    left: 0;
    right: 0;
    height: 1px;
  }

  .line.v1 {
    left: 33.333%;
  }
  .line.v2 {
    left: 66.666%;
  }
  .line.h1 {
    top: 33.333%;
  }
  .line.h2 {
    top: 66.666%;
  }

  .handle {
    appearance: none;
    position: absolute;
    width: 14px;
    height: 14px;
    padding: 0;
    border: 2px solid white;
    border-radius: 999px;
    background: #1a73e8;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
    touch-action: none;
    transform: translate(-50%, -50%);
  }

  .handle-nw {
    top: 0;
    left: 0;
  }
  .handle-n {
    top: 0;
    left: 50%;
  }
  .handle-ne {
    top: 0;
    left: 100%;
  }
  .handle-e {
    top: 50%;
    left: 100%;
  }
  .handle-se {
    top: 100%;
    left: 100%;
  }
  .handle-s {
    top: 100%;
    left: 50%;
  }
  .handle-sw {
    top: 100%;
    left: 0;
  }
  .handle-w {
    top: 50%;
    left: 0;
  }

  .toolbar {
    position: absolute;
    top: 0.75rem;
    left: 0.75rem;
    right: 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-radius: 999px;
    background: color-mix(in srgb, canvas 88%, transparent);
    color: canvastext;
    backdrop-filter: blur(6px);
  }

  .aspect-label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8125rem;
  }

  .aspect-label select {
    font: inherit;
    color: inherit;
    background: color-mix(in srgb, currentColor 8%, transparent);
    border: 0;
    border-radius: 999px;
    padding: 0.25rem 0.6rem;
  }

  .spacer {
    flex: 1;
  }

  .btn {
    border: 0;
    border-radius: 999px;
    padding: 0.4rem 0.9rem;
    font: inherit;
    font-size: 0.8125rem;
    cursor: pointer;
    color: inherit;
  }

  .btn.ghost {
    background: color-mix(in srgb, currentColor 8%, transparent);
  }

  .btn.ghost:hover {
    background: color-mix(in srgb, currentColor 14%, transparent);
  }

  .btn.primary {
    background: #1a73e8;
    color: white;
    font-weight: 600;
  }

  .btn.primary:hover {
    background: #1765cc;
  }
</style>
