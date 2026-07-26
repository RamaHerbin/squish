/**
 * Canvas plumbing for the compare view.
 *
 * Pixels never travel through Svelte templating: `ImageData` is written with
 * `putImageData` from an effect, which is both faster and the only way to avoid
 * re-creating the bitmap on every unrelated re-render.
 */

let displayColorSpace: PredefinedColorSpace | undefined;

/**
 * The widest colour space this browser can present on a 2D canvas, probed once.
 * A `display-p3` context shows both sRGB and P3 `ImageData` correctly
 * (`putImageData` converts into the context space), so presenting everything in
 * the widest space preserves a wide-gamut source without clipping. A browser
 * without P3 canvas falls back to sRGB — the pre-existing behaviour.
 */
function preferredDisplayColorSpace(): PredefinedColorSpace {
  if (displayColorSpace) return displayColorSpace;
  try {
    const probe = document.createElement('canvas').getContext('2d', {
      colorSpace: 'display-p3',
    });
    displayColorSpace =
      probe?.getContextAttributes().colorSpace === 'display-p3' ? 'display-p3' : 'srgb';
  } catch {
    displayColorSpace = 'srgb';
  }
  return displayColorSpace;
}

/**
 * The canvas' 2D context, always requested in the same colour space.
 * `getContext` caches on first call, so every acquisition — `clearCanvas` on
 * mount included — must ask for the same space or the canvas locks to whatever
 * the first (option-less) call chose.
 */
function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  return canvas.getContext('2d', { colorSpace: preferredDisplayColorSpace() });
}

/** Resize `canvas` to match `data` and blit the pixels into it. */
export function drawImageData(canvas: HTMLCanvasElement, data: ImageData): boolean {
  const ctx = context(canvas);
  if (!ctx) return false;

  // Assigning width/height resets the bitmap, so only do it when it changed.
  if (canvas.width !== data.width) canvas.width = data.width;
  if (canvas.height !== data.height) canvas.height = data.height;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.putImageData(data, 0, 0);
  return true;
}

/** Wipe the canvas without disturbing its size. */
export function clearCanvas(canvas: HTMLCanvasElement): void {
  const ctx = context(canvas);
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

/**
 * True when `data` is a different size from the reference image, i.e. the
 * canvas must be letterboxed (`object-fit: contain`) to stay aligned with the
 * other side of the split.
 */
export function needsContainFit(
  data: { width: number; height: number } | undefined,
  reference: { width: number; height: number } | undefined,
): boolean {
  if (!data || !reference) return false;
  return data.width !== reference.width || data.height !== reference.height;
}
