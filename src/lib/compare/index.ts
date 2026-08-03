/**
 * Compare — the image bed at the centre of the editor.
 *
 * ```svelte
 * <script lang="ts">
 *   import { RevealCompare } from '../compare';
 * </script>
 *
 * <RevealCompare
 *   original={engine.state.sides[0].data}
 *   output={engine.state.sides[1].data}
 *   source={referencePixels}
 *   sourceKey={engine.state.source?.file}
 *   originalSize="2.92 MB"
 *   originalMeta="JPEG · 4032 × 3024"
 *   outputSize="390 kB"
 *   outputDelta="−87%"
 *   outputMeta="AVIF · q52 · 4032 × 3024"
 *   onrotate={rotate}
 *   {editState}
 *   onCropApply={applyCrop}
 * />
 * ```
 *
 * `RevealCompare` is the whole surface: two canvases under one shared pan/zoom
 * transform, the reveal divider, the read-out cards and the floating pill.
 * `ZoomPill` is exported for anything that wants to place it elsewhere, and
 * `reveal.ts` holds the pure maths behind all of it.
 *
 * The pre-redesign surface (`CompareView` / `TwoUp` / `PinchZoom` and their
 * `types.ts`) was deleted with the redesign — `pinch-zoom.ts` survives it and
 * is what `RevealCompare` drives its shared transform with.
 */

export { default as RevealCompare } from './RevealCompare.svelte';
export { default as ZoomPill } from './ZoomPill.svelte';
export { default as OutputCanvas } from './OutputCanvas.svelte';

export * from './pinch-zoom';
export * from './reveal';
export * from './canvas';
