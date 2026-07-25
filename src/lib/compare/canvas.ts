/**
 * Canvas plumbing for the compare view.
 *
 * Pixels never travel through Svelte templating: `ImageData` is written with
 * `putImageData` from an effect, which is both faster and the only way to avoid
 * re-creating the bitmap on every unrelated re-render.
 */

/** Resize `canvas` to match `data` and blit the pixels into it. */
export function drawImageData(canvas: HTMLCanvasElement, data: ImageData): boolean {
  const context = canvas.getContext('2d');
  if (!context) return false;

  // Assigning width/height resets the bitmap, so only do it when it changed.
  if (canvas.width !== data.width) canvas.width = data.width;
  if (canvas.height !== data.height) canvas.height = data.height;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.putImageData(data, 0, 0);
  return true;
}

/** Wipe the canvas without disturbing its size. */
export function clearCanvas(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
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
