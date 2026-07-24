/**
 * Minimal canvas helpers shared by the batch pipeline and the thumbnailer.
 *
 * `OffscreenCanvas` is preferred (no DOM churn, works if this ever moves into a
 * worker) with an `HTMLCanvasElement` fallback for older Safari. Both are
 * addressed through {@link Ctx2d}, a hand-rolled structural type: the DOM lib's
 * two 2D context interfaces are not assignable to one another, and a union of
 * them makes every `drawImage` call an overload-resolution puzzle.
 */

/** Either canvas flavour. */
export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

/** The slice of the 2D context both flavours agree on. */
export interface Ctx2d {
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: ImageSmoothingQuality;
  clearRect(x: number, y: number, width: number, height: number): void;
  putImageData(data: ImageData, dx: number, dy: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData;
  drawImage(image: CanvasImageSource, dx: number, dy: number): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
  drawImage(
    image: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}

export function canvasSupported(): boolean {
  return typeof OffscreenCanvas === 'function' || typeof document !== 'undefined';
}

export function createCanvas(width: number, height: number): AnyCanvas {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));

  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  if (typeof document === 'undefined') {
    throw new Error('No canvas implementation available in this environment');
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

export function context2d(canvas: AnyCanvas, willReadFrequently = false): Ctx2d {
  const context = (canvas as HTMLCanvasElement).getContext('2d', { willReadFrequently });
  if (!context) throw new Error('Could not acquire a 2D canvas context');
  return context as unknown as Ctx2d;
}

/**
 * Encode a canvas, preferring `convertToBlob`.
 *
 * Browsers silently fall back to PNG for a MIME type they cannot encode, which
 * would hand the user a `.webp` full of PNG bytes — so the result type is
 * verified rather than trusted.
 */
export async function canvasToBlob(
  canvas: AnyCanvas,
  type: string,
  quality?: number,
): Promise<Blob> {
  let blob: Blob | null;

  if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function') {
    blob = await canvas.convertToBlob({ type, quality });
  } else {
    const element = canvas as HTMLCanvasElement;
    blob = await new Promise<Blob | null>((resolve) => {
      element.toBlob((result) => resolve(result), type, quality);
    });
  }

  if (!blob) throw new Error(`This browser cannot encode ${type}`);
  if (blob.type && blob.type !== type) {
    throw new Error(`This browser cannot encode ${type} (produced ${blob.type})`);
  }
  return blob;
}

/** Pull pixels out of anything drawable. */
export function imageDataFrom(
  source: CanvasImageSource,
  width: number,
  height: number,
): ImageData {
  const canvas = createCanvas(width, height);
  const context = context2d(canvas, true);
  context.drawImage(source, 0, 0, width, height);
  return context.getImageData(0, 0, Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
}

/** Largest box with `source`'s aspect ratio that fits inside `max` (never upscales). */
export function containSize(
  sourceWidth: number,
  sourceHeight: number,
  max: number,
): { width: number; height: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0) return { width: 1, height: 1 };
  const scale = Math.min(1, max / Math.max(sourceWidth, sourceHeight));
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}
