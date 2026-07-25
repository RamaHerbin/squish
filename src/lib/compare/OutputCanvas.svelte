<script lang="ts">
  /**
   * Draws an `ImageData` to a canvas imperatively.
   *
   * The bitmap is written with `putImageData` inside an `$effect` — never
   * through the template — so a slider drag repaints a canvas instead of
   * rebuilding one. The canvas's *attribute* size follows the pixels; its CSS
   * size follows the reference image, which is what keeps both halves of the
   * split aligned when one side has been resized.
   */
  import { clearCanvas, drawImageData } from './canvas';

  interface Props {
    /** Pixels to display. Undefined clears the canvas. */
    data?: ImageData;
    /** CSS width in px — normally the *source* width, not `data.width`. */
    displayWidth?: number;
    /** CSS height in px — normally the *source* height, not `data.height`. */
    displayHeight?: number;
    /** Letterbox rather than stretch when `data` is a different size. */
    contain?: boolean;
    /** `image-rendering: pixelated`, for inspecting compression artefacts. */
    pixelated?: boolean;
    /** Accessible name, e.g. `"Original"`. */
    label?: string;
    class?: string;
  }

  let {
    data,
    displayWidth,
    displayHeight,
    contain = false,
    pixelated = false,
    label,
    class: className = '',
  }: Props = $props();

  let canvas = $state<HTMLCanvasElement>();

  $effect(() => {
    const element = canvas;
    const pixels = data;
    if (!element) return;
    if (!pixels) {
      clearCanvas(element);
      return;
    }
    drawImageData(element, pixels);
  });
</script>

<canvas
  bind:this={canvas}
  class="output-canvas {className}"
  class:pixelated
  class:contain
  style:width={displayWidth === undefined ? undefined : `${displayWidth}px`}
  style:height={displayHeight === undefined ? undefined : `${displayHeight}px`}
  aria-label={label}
>
  <!-- Canvas fallback content is the accessible name of last resort. -->
  {label ?? ''}
</canvas>

<style>
  .output-canvas {
    display: block;
    /* Chrome paints a stale tile without this when the canvas is transformed.
       https://bugs.chromium.org/p/chromium/issues/detail?id=870222 */
    will-change: auto;
    /* Never let flexbox reshape the image. */
    flex-shrink: 0;
    max-width: none;
    max-height: none;
  }

  .contain {
    object-fit: contain;
  }

  .pixelated {
    image-rendering: pixelated;
  }
</style>
