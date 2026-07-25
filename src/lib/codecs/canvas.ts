/**
 * Canvas-backed helpers: the browser's own encoder, rasteriser and resampler.
 *
 * Every function works from either a `Window` or a worker realm — an
 * `OffscreenCanvas` is used whenever there is no `document`. Nothing here
 * touches a DOM global at module scope, so the module can be imported (though
 * not called) from Node.
 *
 * Ported from Squoosh's `client/lazy-app/util/canvas.ts`.
 */

import { hasDocument, hasOffscreenCanvas } from './capabilities';

/* -------------------------------------------------------------------------- */
/* Canvas plumbing                                                             */
/* -------------------------------------------------------------------------- */

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * The slice of `CanvasRenderingContext2D` this module uses.
 *
 * Declared structurally because `OffscreenCanvasRenderingContext2D` is not
 * assignable to `CanvasRenderingContext2D` (their `canvas` fields differ), yet
 * both implement everything below identically.
 */
interface Canvas2DLike {
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: ImageSmoothingQuality;
  clearRect(x: number, y: number, width: number, height: number): void;
  putImageData(data: ImageData, dx: number, dy: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData;
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

/** Allocate the best canvas this realm offers. */
export function createCanvas(width: number, height: number): AnyCanvas {
  if (hasDocument()) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  if (hasOffscreenCanvas()) return new OffscreenCanvas(width, height);
  throw new Error('No canvas implementation is available in this environment');
}

function context2d(canvas: AnyCanvas): Canvas2DLike {
  const ctx = (canvas as HTMLCanvasElement).getContext('2d');
  if (!ctx) throw new Error('Could not create a 2D canvas context');
  return ctx as unknown as Canvas2DLike;
}

/** Replace a canvas' contents with `data`. */
export function drawDataToCanvas(canvas: AnyCanvas, data: ImageData): void {
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.putImageData(data, 0, 0);
}

/* -------------------------------------------------------------------------- */
/* Encoding                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Encode pixels with the browser's own encoder.
 *
 * @param type a MIME type such as `image/jpeg`.
 * @param quality 0–1. Ignored by lossless formats.
 * @throws when the encoder returns nothing at all. Note that a browser which
 *   cannot write `type` may silently return a PNG instead — check `blob.type`
 *   (that is what {@link canEncodeImageType} does).
 */
export async function canvasEncode(
  data: ImageData,
  type: string,
  quality?: number,
): Promise<Blob> {
  const canvas = createCanvas(data.width, data.height);
  context2d(canvas).putImageData(data, 0, 0);

  let blob: Blob | null = null;

  if (typeof (canvas as HTMLCanvasElement).toBlob === 'function') {
    blob = await new Promise<Blob | null>((resolve) => {
      (canvas as HTMLCanvasElement).toBlob(resolve, type, quality);
    });
  } else {
    blob = await (canvas as OffscreenCanvas).convertToBlob({ type, quality });
  }

  if (!blob) throw new Error(`The browser could not encode ${type}`);
  return blob;
}

/* -------------------------------------------------------------------------- */
/* Rasterising                                                                 */
/* -------------------------------------------------------------------------- */

export interface DrawableToImageDataOptions {
  width?: number;
  height?: number;
  sx?: number;
  sy?: number;
  sw?: number;
  sh?: number;
}

type Drawable = ImageBitmap | HTMLImageElement | VideoFrame | HTMLCanvasElement | OffscreenCanvas;

function drawableWidth(drawable: Drawable): number {
  // `naturalWidth` beats `width` on an <img>: the latter reflects layout, which
  // is meaningless for an element that was never inserted into a document.
  if ('naturalWidth' in drawable && drawable.naturalWidth) return drawable.naturalWidth;
  if ('width' in drawable && typeof drawable.width === 'number') return drawable.width;
  return (drawable as VideoFrame).displayWidth;
}

function drawableHeight(drawable: Drawable): number {
  if ('naturalHeight' in drawable && drawable.naturalHeight) return drawable.naturalHeight;
  if ('height' in drawable && typeof drawable.height === 'number') return drawable.height;
  return (drawable as VideoFrame).displayHeight;
}

/** Draw anything canvas-drawable and read the pixels back out. */
export function drawableToImageData(
  drawable: Drawable,
  options: DrawableToImageDataOptions = {},
): ImageData {
  const naturalWidth = drawableWidth(drawable);
  const naturalHeight = drawableHeight(drawable);
  const {
    width = naturalWidth,
    height = naturalHeight,
    sx = 0,
    sy = 0,
    sw = naturalWidth,
    sh = naturalHeight,
  } = options;

  if (width < 1 || height < 1) throw new Error('Cannot rasterise to a zero-sized canvas');

  const canvas = createCanvas(width, height);
  const ctx = context2d(canvas);
  ctx.drawImage(drawable as CanvasImageSource, sx, sy, sw, sh, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/* -------------------------------------------------------------------------- */
/* Built-in resampling                                                         */
/* -------------------------------------------------------------------------- */

/** Maps `ResizeMethod`'s `browser-*` members onto canvas settings. */
export type BuiltinResizeMethod = 'pixelated' | 'low' | 'medium' | 'high';

/**
 * Resample with the browser's own scaler.
 *
 * Main-thread-ish counterpart to `@jsquash/resize`: much faster, much less
 * controllable. `pixelated` disables smoothing entirely (nearest neighbour).
 */
export function builtinResize(
  data: ImageData,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  method: BuiltinResizeMethod,
): ImageData {
  const source = createCanvas(data.width, data.height);
  drawDataToCanvas(source, data);

  const dest = createCanvas(dw, dh);
  const ctx = context2d(dest);

  if (method === 'pixelated') {
    ctx.imageSmoothingEnabled = false;
  } else {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = method;
  }

  ctx.drawImage(source as CanvasImageSource, sx, sy, sw, sh, 0, 0, dw, dh);
  return ctx.getImageData(0, 0, dw, dh);
}

/* -------------------------------------------------------------------------- */
/* Blob / image element helpers                                                */
/* -------------------------------------------------------------------------- */

/** Load an `<img>` from a URL, preferring the off-thread `decode()` path. */
export async function loadImageElement(url: string): Promise<HTMLImageElement> {
  if (!hasDocument()) throw new Error('<img> decoding requires a document');

  const img = new Image();
  img.decoding = 'async';
  img.src = url;

  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Image loading error'));
  });

  if (typeof img.decode === 'function') {
    // Safari throws from decode() on SVG sources (webkit bug 188347), so the
    // rejection is swallowed and `loaded` is awaited regardless.
    await img.decode().catch(() => null);
  }

  await loaded;
  return img;
}

/** Decode a blob through an `<img>` element. */
export async function blobToImg(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    return await loadImageElement(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
