<script lang="ts">
  /**
   * The editor's image bed (comp "02 Editor", mobile "06b"): the original and
   * the encode stacked in the same place under **one** pan/zoom transform, with
   * the output revealed to the right of a draggable divider.
   *
   * ## One transform, two canvases
   * A single {@link PinchZoomController} is attached to the `.stage` element,
   * which is an ancestor of both panes. The controller writes `--x` / `--y` /
   * `--scale` onto it, and both `.content` boxes read those inherited custom
   * properties — so the two halves cannot drift apart, and the split needs no
   * event retargeting (the old `CompareView` cloned every pointerdown onto the
   * left viewport; here the listeners already sit above both panes).
   *
   * The reveal is a `clip-path: inset(0 0 0 var(--split))` on the output pane,
   * i.e. a *viewport-space* percentage of the surface — nothing is re-painted
   * when the divider moves, and no measurement is needed for it either.
   *
   * ## Divider
   * Position is a fraction, never pixels, so a resize can never desync it. It
   * is controlled if `split` is passed and self-owned otherwise; either way
   * `onsplit` reports every move. Drag with a pointer, nudge with the arrows
   * while the handle has focus, or press `1` / `2` / `3` for 0 / 50 / 100%.
   *
   * ## Pixels
   * `ImageData` goes in as props and is blitted with `putImageData` inside
   * `OutputCanvas` — never through the template, so a slider drag repaints a
   * canvas instead of rebuilding one.
   */
  import { untrack } from 'svelte';

  import type { CropRect } from '../contracts';
  import CropOverlay from '../edit/CropOverlay.svelte';
  import { InfoCard, accentFill } from '../ui';

  import AutoPill from './AutoPill.svelte';
  import OutputCanvas from './OutputCanvas.svelte';
  import ZoomPill from './ZoomPill.svelte';
  import { needsContainFit } from './canvas';
  import { PinchZoomController, type PinchZoomTransform } from './pinch-zoom';
  import {
    COMPACT_REVEAL_SPLIT,
    DEFAULT_REVEAL_SPLIT,
    REVEAL_COMPACT_QUERY,
    clampSplit,
    isTypingTarget,
    splitForDigit,
    splitForKey,
    splitFromDrag,
    splitPercent,
    toImagePointIn,
    toViewportPointIn,
    type RevealLayout,
    type RevealPoint,
  } from './reveal';
  import type { RevealCompareProps } from './reveal';

  let {
    original,
    output,
    source,
    sourceKey,
    split: splitProp,
    defaultSplit,
    onsplit,
    compact: compactProp,
    pixelated = false,
    originalLabel = 'Original',
    outputLabel = 'Output',
    originalSize,
    originalMeta,
    outputSize,
    outputDelta,
    outputDeltaTone = 'yellow',
    outputMeta,
    showInfo = true,
    autoOpen = false,
    autoMessage = '',
    autoLabel = 'Auto',
    autoActionLabel = 'Applied',
    onauto,
    showZoom = true,
    onrotate,
    oncrop,
    onzoomchange,
    editState,
    cropImageWidth,
    cropImageHeight,
    crop,
    onCropApply,
    onCropCancel,
    placeholder,
    shortcuts = true,
    class: className = '',
  }: RevealCompareProps = $props();

  /* ------------------------------------------------------------------ */
  /* Elements & measurement                                              */
  /* ------------------------------------------------------------------ */

  let root = $state<HTMLDivElement>();
  let stage = $state<HTMLDivElement>();
  let content = $state<HTMLDivElement>();

  let stageWidth = $state(0);
  let stageHeight = $state(0);

  /* ------------------------------------------------------------------ */
  /* Breakpoint                                                          */
  /* ------------------------------------------------------------------ */

  let compactMatch = $state(false);
  const compact = $derived(compactProp ?? compactMatch);

  $effect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(REVEAL_COMPACT_QUERY);
    compactMatch = query.matches;
    const onChange = (event: MediaQueryListEvent) => (compactMatch = event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  });

  /* ------------------------------------------------------------------ */
  /* Divider                                                             */
  /* ------------------------------------------------------------------ */

  // Deliberate initial-value capture: defaultSplit only seeds the position.
  // svelte-ignore state_referenced_locally
  let internalSplit = $state(clampSplit(defaultSplit ?? DEFAULT_REVEAL_SPLIT));
  let dragging = $state(false);
  /** Plain, not `$state`: read inside effects, never a dependency of one. */
  let splitTouched = false;

  const split = $derived(clampSplit(splitProp ?? internalSplit));
  const splitCss = $derived(`${(split * 100).toFixed(3)}%`);
  const splitLabel = $derived(splitPercent(split));

  function setSplit(next: number): void {
    const value = clampSplit(next);
    // Read before writing: `split` is derived, so it would already report the
    // new value by the time the comparison ran.
    const previous = split;
    splitTouched = true;
    if (splitProp === undefined) internalSplit = value;
    if (value !== previous) onsplit?.(value);
  }

  /* The comp puts the divider at 46% on desktop and 52% on mobile. Follow the
     breakpoint until the user takes ownership of it. */
  $effect(() => {
    const target = compact ? COMPACT_REVEAL_SPLIT : DEFAULT_REVEAL_SPLIT;
    if (splitTouched || defaultSplit !== undefined || splitProp !== undefined) return;
    untrack(() => (internalSplit = target));
  });

  function onDividerPointerDown(event: PointerEvent): void {
    const element = root;
    if (!element) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0) return;
    if (event.cancelable) event.preventDefault();

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startSplit = split;
    dragging = true;
    // Focus explicitly: preventDefault above suppressed the native focus, and
    // a dragged divider should keep the arrow keys.
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();

    // Window listeners rather than pointer capture: the pointer routinely
    // leaves the 28px strip, and capture misbehaves in Safari.
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      setSplit(splitFromDrag(startSplit, moveEvent.clientX - startX, bounds.width));
    };
    const onEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      dragging = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  }

  function onDividerKeydown(event: KeyboardEvent): void {
    const next = splitForKey(split, event.key, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    setSplit(next);
  }

  /* `1` / `2` / `3` snap the divider, wherever focus is — unless it is in a
     text field, which includes the zoom pill's percentage. */
  $effect(() => {
    if (!shortcuts || typeof window === 'undefined') return;

    const onKeydown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const next = splitForDigit(event.code);
      if (next === null) return;
      event.preventDefault();
      setSplit(next);
    };

    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  /* ------------------------------------------------------------------ */
  /* Shared pan / zoom                                                   */
  /* ------------------------------------------------------------------ */

  let scale = $state(1);
  let view = $state<PinchZoomTransform>({ x: 0, y: 0, scale: 1 });

  const zoom = new PinchZoomController({
    onChange: (transform) => {
      view = transform;
      scale = transform.scale;
      onzoomchange?.(transform.scale);
    },
  });

  const zoomAboutCentre = { originX: '50%', originY: '50%', relativeTo: 'container' } as const;

  function zoomTo(next: number): void {
    zoom.scaleTo(next, zoomAboutCentre);
  }

  function fitToViewport(): void {
    zoom.fit();
  }

  $effect(() => {
    const container = stage;
    const target = content;
    if (!container || !target) return;
    zoom.attach(container, target);
    return () => zoom.detach();
  });

  /* Crop owns the pointer while it is open. */
  const cropping = $derived(editState?.mode === 'cropping');

  $effect(() => {
    zoom.interactive = !cropping;
  });

  /* ------------------------------------------------------------------ */
  /* Derived render inputs                                               */
  /* ------------------------------------------------------------------ */

  /**
   * The image both canvases are sized against: `source` when supplied (the
   * preprocessed pixels), otherwise whichever side has any. A resized side
   * letterboxes into this box instead of dragging the other half out of
   * alignment.
   */
  const reference = $derived(source ?? original ?? output);
  const originalData = $derived(original ?? reference);
  const outputData = $derived(output ?? reference);
  const originalContain = $derived(needsContainFit(originalData, reference));
  const outputContain = $derived(needsContainFit(outputData, reference));
  const displayWidth = $derived(reference?.width);
  const displayHeight = $derived(reference?.height);

  const hasOriginalInfo = $derived(Boolean(originalSize || originalMeta));
  const hasOutputInfo = $derived(Boolean(outputSize || outputMeta || outputDelta));
  const compactOutputText = $derived(
    [outputSize, outputDelta].filter((part): part is string => Boolean(part)).join(' · '),
  );

  /* ------------------------------------------------------------------ */
  /* Measurement                                                         */
  /* ------------------------------------------------------------------ */

  /** Plain: guards a one-off refit without making the effect self-dependent. */
  let hasMeasured = false;

  $effect(() => {
    const element = stage;
    if (!element || typeof ResizeObserver === 'undefined') return;

    // Writes only — reading `stageWidth` here would make the effect depend on
    // its own output, and reading `reference` would rebuild the observer on
    // every encode.
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      stageWidth = width;
      stageHeight = height;
      // First real layout: a `fit()` that ran against a zero-sized box did
      // nothing, so run it once more now there is something to fit into.
      if (!hasMeasured && width > 0 && height > 0) {
        hasMeasured = true;
        zoom.fit();
      }
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  });

  /* ------------------------------------------------------------------ */
  /* Source changes                                                      */
  /* ------------------------------------------------------------------ */

  // Deliberately plain (not `$state`): read and written inside the effect only,
  // so they can never feed back into its dependencies.
  let previousSource: ImageData | undefined;
  let previousKey: unknown;
  let seenFirstSource = false;

  $effect(() => {
    const image = reference;
    const key = sourceKey;

    if (!image) {
      previousSource = undefined;
      previousKey = key;
      return;
    }

    if (!seenFirstSource || key !== previousKey || !previousSource) {
      // New file: start from a clean, fitted view.
      seenFirstSource = true;
      zoom.reset();
      zoom.fit();
    } else if (
      previousSource !== image &&
      (previousSource.width !== image.width || previousSource.height !== image.height)
    ) {
      // Rotate or crop: the content changed size under a static transform, so
      // compensate to keep what the user was looking at in the middle.
      zoom.recenterForContentSizeChange(
        previousSource.width,
        previousSource.height,
        image.width,
        image.height,
      );
    }

    previousSource = image;
    previousKey = key;
  });

  /* ------------------------------------------------------------------ */
  /* Crop                                                                */
  /* ------------------------------------------------------------------ */

  const layout = $derived<RevealLayout>({
    containerWidth: stageWidth,
    containerHeight: stageHeight,
    contentWidth: displayWidth ?? 0,
    contentHeight: displayHeight ?? 0,
    x: view.x,
    y: view.y,
    scale: view.scale,
  });

  /**
   * The space `crop` is defined in — the *rotated source*, which is only the
   * same as the displayed pixels while nothing is cropped. Callers that crop a
   * second time should feed the rotated, uncropped pixels as `source` for the
   * duration of crop mode and leave these alone.
   */
  const cropWidth = $derived(Math.max(1, cropImageWidth ?? displayWidth ?? 1));
  const cropHeight = $derived(Math.max(1, cropImageHeight ?? displayHeight ?? 1));

  function toImagePoint(point: RevealPoint): RevealPoint {
    return toImagePointIn(layout, cropWidth, cropHeight, point);
  }

  function toViewportPoint(point: RevealPoint): RevealPoint {
    return toViewportPointIn(layout, cropWidth, cropHeight, point);
  }

  function handleCropApply(rect: CropRect): void {
    onCropApply?.(rect);
  }

  function handleCropCancel(): void {
    onCropCancel?.();
  }

  function toggleCrop(): void {
    if (oncrop) oncrop();
    else editState?.toggleCrop();
  }

  const cropSegment = $derived(oncrop || editState ? toggleCrop : undefined);
</script>

<div
  bind:this={root}
  class="reveal {className}"
  class:compact
  class:cropping
  style="--split: {splitCss}"
>
  <div bind:this={stage} class="stage">
    <div class="pane">
      <div bind:this={content} class="content">
        <OutputCanvas
          data={originalData}
          {displayWidth}
          {displayHeight}
          {pixelated}
          contain={originalContain}
          label={originalLabel}
        />
      </div>
    </div>

    <div class="pane pane-output">
      <div class="content">
        <OutputCanvas
          data={outputData}
          {displayWidth}
          {displayHeight}
          {pixelated}
          contain={outputContain}
          label={outputLabel}
        />
      </div>
    </div>
  </div>

  <!-- Texture over the output half only: the encode reads as a print, and the
       eye stops treating a 1px seam as the only difference between the two. -->
  <div class="scanlines" aria-hidden="true"></div>

  {#if !reference && placeholder}
    <p class="placeholder">{placeholder}</p>
  {/if}

  <div
    class="divider"
    class:dragging
    role="slider"
    tabindex="0"
    aria-label="Reveal divider"
    aria-orientation="horizontal"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={splitLabel}
    aria-valuetext="{splitLabel}% output"
    onpointerdown={onDividerPointerDown}
    onkeydown={onDividerKeydown}
    ondblclick={() => setSplit(0.5)}
  >
    <span class="divider-line" aria-hidden="true"></span>
    <span class="handle" aria-hidden="true">
      <span class="glyph glyph-left"></span>
      <span class="glyph glyph-right"></span>
    </span>
  </div>

  {#if showInfo && !compact}
    {#if hasOriginalInfo}
      <div class="card card-original">
        <InfoCard label={originalLabel}>
          {#if originalSize}<span class="figure">{originalSize}</span>{/if}
          {#if originalMeta}<span class="meta">{originalMeta}</span>{/if}
        </InfoCard>
      </div>
    {/if}

    {#if hasOutputInfo}
      <div class="card card-output">
        <InfoCard label={outputLabel} variant="ink" align="end">
          <span class="figure-row">
            {#if outputSize}<span class="figure">{outputSize}</span>{/if}
            {#if outputDelta}
              <span class="delta" style:color={accentFill(outputDeltaTone)}>{outputDelta}</span>
            {/if}
          </span>
          {#if outputMeta}<span class="meta meta-ink">{outputMeta}</span>{/if}
        </InfoCard>
      </div>
    {/if}
  {/if}

  {#if showInfo && compact}
    {#if originalSize}<span class="tag tag-original">{originalSize}</span>{/if}
    {#if compactOutputText}<span class="tag tag-output">{compactOutputText}</span>{/if}
  {/if}

  {#if autoMessage}
    <div class="auto-slot">
      <AutoPill
        open={autoOpen}
        message={autoMessage}
        label={autoLabel}
        actionLabel={autoActionLabel}
        onaction={onauto}
        {compact}
      />
    </div>
  {/if}

  {#if showZoom}
    <div class="zoom-slot">
      <ZoomPill
        {scale}
        onzoom={zoomTo}
        onfit={fitToViewport}
        {onrotate}
        oncrop={cropSegment}
        {cropping}
        {compact}
        disabled={!reference}
      />
    </div>
  {/if}

  {#if editState}
    <CropOverlay
      {editState}
      imageWidth={cropWidth}
      imageHeight={cropHeight}
      {crop}
      {toImagePoint}
      {toViewportPoint}
      onApply={handleCropApply}
      onCancel={handleCropCancel}
    />
  {/if}
</div>

<style>
  .reveal {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--image-bed);
  }

  /* ---- the two canvases -------------------------------------------- */

  .stage {
    /* Written by the controller; inherited by both `.content` boxes, which is
       what makes the two halves share one transform. */
    --x: 0px;
    --y: 0px;
    --scale: 1;

    position: absolute;
    inset: 0;
    overflow: hidden;
    /* Every gesture belongs to us, none to the browser's scroller. */
    touch-action: none;
  }

  .pane {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  /* Viewport-space reveal: no pixels move when the divider does. */
  .pane-output {
    clip-path: inset(0 0 0 var(--split));
  }

  .content {
    flex: 0 0 auto;
    /* Kills the inline-layout descender gap under a <canvas>. */
    line-height: 0;
    transform: translate(var(--x), var(--y)) scale(var(--scale));
    transform-origin: 0 0;
    will-change: transform;
  }

  .scanlines {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: var(--split);
    z-index: 1;
    background-image:
      repeating-linear-gradient(0deg, rgb(0 0 0 / 3.5%) 0 1px, transparent 1px 4px),
      repeating-linear-gradient(90deg, rgb(0 0 0 / 3.5%) 0 1px, transparent 1px 4px);
    backdrop-filter: blur(0.7px) saturate(1.08) contrast(1.04);
    pointer-events: none;
  }

  .placeholder {
    position: absolute;
    top: 50%;
    left: 50%;
    z-index: 1;
    transform: translate(-50%, -50%);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono-wide);
    text-transform: uppercase;
    color: var(--faint);
    text-align: center;
    pointer-events: none;
  }

  /* ---- divider ------------------------------------------------------ */

  .divider {
    position: absolute;
    top: 0;
    bottom: 0;
    left: var(--split);
    z-index: 2;
    width: 28px;
    transform: translateX(-50%);
    touch-action: none;
    cursor: ew-resize;
    outline: none;
  }

  .divider-line {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1px;
    transform: translateX(-50%);
    background: var(--ink);
  }

  .handle {
    position: absolute;
    top: 50%;
    left: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    width: 46px;
    height: 46px;
    border: var(--border-ink);
    border-radius: 50%;
    background: var(--paper);
    transform: translate(-50%, -50%);
    transition: background var(--duration-fast) var(--ease-standard);
  }

  .divider:hover .handle,
  .divider.dragging .handle {
    background: var(--surface);
  }

  .divider:focus-visible .handle {
    outline: var(--focus-ring-width) solid var(--focus-ring-color);
    outline-offset: var(--focus-ring-offset);
  }

  .glyph {
    width: 0;
    height: 0;
    border-top: 5px solid transparent;
    border-bottom: 5px solid transparent;
  }

  .glyph-left {
    border-right: 6px solid var(--ink);
  }

  .glyph-right {
    border-left: 6px solid var(--ink);
  }

  /* ---- read-outs ---------------------------------------------------- */

  .card {
    position: absolute;
    top: 20px;
    z-index: 3;
    max-width: calc(50% - 28px);
    pointer-events: none;
  }

  .card-original {
    left: 20px;
  }

  .card-output {
    right: 20px;
  }

  .figure-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }

  /* 18px is the comp's one-off between --fs-mono-xl (17) and --fs-mono-2xl. */
  .figure {
    font-family: var(--font-mono);
    font-size: 18px;
    font-weight: var(--fw-strong);
    letter-spacing: var(--tracking-tight);
  }

  .delta {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-lg);
    font-weight: var(--fw-strong);
  }

  .meta {
    max-width: 100%;
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono-tight);
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meta-ink {
    color: var(--cream-muted);
  }

  /* Mobile 06b: the cards collapse to two pills. */
  .tag {
    position: absolute;
    top: 14px;
    z-index: 3;
    max-width: calc(50% - 20px);
    padding: 7px 10px;
    border-radius: var(--radius-pill);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono);
    text-transform: uppercase;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }

  .tag-original {
    left: 14px;
    background: var(--paper);
    border: var(--border-ink);
  }

  .tag-output {
    right: 14px;
    background: var(--ink);
    color: var(--cream);
  }

  /* ---- floating controls -------------------------------------------- */

  .auto-slot {
    position: absolute;
    top: 20px;
    left: 50%;
    z-index: 3;
    max-width: min(560px, calc(100% - 40px));
    transform: translateX(-50%);
  }

  .zoom-slot {
    position: absolute;
    bottom: 20px;
    left: 50%;
    z-index: 3;
    transform: translateX(-50%);
  }

  .compact .auto-slot {
    top: 62px;
    max-width: calc(100% - 28px);
  }

  .compact .zoom-slot {
    bottom: 14px;
  }

  .compact .handle {
    width: 44px;
    height: 44px;
  }

  /* `CropOverlay` fills the surface at z-index 10, so the pill has to climb
     over it or there would be no way back out of crop mode. */
  .cropping .zoom-slot {
    z-index: 11;
  }

  @media (pointer: coarse) {
    .divider {
      width: 44px;
    }
  }

  /* ---- crop mode ----------------------------------------------------- */

  /**
   * Crop is absent from the comps, and `edit/CropOverlay.svelte` belongs to
   * another directory — so its chrome is re-skinned from here instead of
   * edited. Each selector is deliberately one class deeper than the overlay's
   * own scoped rules, which is what lets it win without `!important`.
   */
  .reveal :global(.crop-overlay[role='dialog'] .toolbar) {
    top: 20px;
    right: 20px;
    left: 20px;
    gap: var(--space-3);
    padding: 8px 8px 8px 16px;
    border: var(--border-ink);
    border-radius: var(--radius-pill);
    background: var(--paper);
    color: var(--ink);
    backdrop-filter: none;
  }

  .reveal :global(.crop-overlay .toolbar .aspect-label) {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono-wider);
    text-transform: uppercase;
    color: var(--muted);
  }

  .reveal :global(.crop-overlay .toolbar .aspect-label select) {
    height: var(--h-control);
    padding: 0 10px;
    border: var(--border-ink);
    border-radius: var(--radius-input);
    background: var(--surface);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono);
    text-transform: uppercase;
  }

  .reveal :global(.crop-overlay .toolbar .btn) {
    height: var(--h-control);
    padding: 0 18px;
    border-radius: var(--radius-pill);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    font-weight: var(--fw-strong);
    letter-spacing: var(--tracking-mono-wide);
    text-transform: uppercase;
  }

  .reveal :global(.crop-overlay .toolbar .btn.ghost) {
    border: var(--border-ink);
    background: transparent;
    color: var(--ink);
  }

  .reveal :global(.crop-overlay .toolbar .btn.ghost:hover) {
    background: var(--cream);
  }

  .reveal :global(.crop-overlay .toolbar .btn.primary) {
    background: var(--ink);
    color: var(--cream);
  }

  .reveal :global(.crop-overlay .toolbar .btn.primary:hover) {
    background: var(--accent-blue);
  }

  .reveal :global(.crop-overlay .rect) {
    box-shadow: 0 0 0 1.5px var(--paper);
  }

  .reveal :global(.crop-overlay .rect .handle) {
    border: 2px solid var(--paper);
    background: var(--accent-blue);
    box-shadow: 0 0 0 1.5px var(--ink);
  }
</style>
