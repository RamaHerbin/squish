/**
 * Grid thumbnails.
 *
 * Three constraints shape this:
 *
 * 1. **Never hold a full-size decode.** `createImageBitmap(blob, { resizeWidth })`
 *    lets the browser decode *to scale*, so a 40 MP JPEG becomes a 120 px
 *    bitmap without a 160 MB intermediate. The bitmap is closed immediately
 *    after being painted.
 * 2. **Never fight the encoder for CPU.** Thumbnailing is throttled to a couple
 *    of concurrent decodes; the batch lanes are the priority.
 * 3. **Never leak object URLs.** Entries live in an LRU that revokes on evict,
 *    on `delete()` and on `clear()`.
 *
 * Formats the browser cannot decode (JXL today, AVIF on older Safari) resolve
 * to `undefined` rather than throwing — the card shows a placeholder.
 */

import { canvasToBlob, containSize, context2d, createCanvas } from './canvas';

/** Longest edge of a generated thumbnail, in CSS pixels before DPR scaling. */
export const THUMBNAIL_SIZE = 120;

/** How many thumbnails may be decoded at once. */
export const THUMBNAIL_CONCURRENCY = 2;

export interface ThumbnailCacheOptions {
  /** Longest edge in px. Defaults to {@link THUMBNAIL_SIZE}. */
  size?: number;
  /** LRU capacity. Defaults to 200 entries. */
  maxEntries?: number;
  /** Output MIME type. Defaults to WebP, falling back to PNG. */
  type?: string;
  /** Parallel decodes. Defaults to {@link THUMBNAIL_CONCURRENCY}. */
  concurrency?: number;
}

export interface ThumbnailCache {
  /** Cached URL for `key`, without starting any work. */
  peek(key: string): string | undefined;
  /** Cached URL, or decode `source` and cache it. `undefined` if undecodable. */
  get(key: string, source: Blob): Promise<string | undefined>;
  /** Forget one entry, revoking its URL. */
  delete(key: string): void;
  /** Forget everything, revoking every URL. */
  clear(): void;
}

export function createThumbnailCache(options: ThumbnailCacheOptions = {}): ThumbnailCache {
  const size = options.size ?? THUMBNAIL_SIZE;
  const maxEntries = Math.max(1, options.maxEntries ?? 200);
  const type = options.type ?? 'image/webp';
  const limit = createLimiter(Math.max(1, options.concurrency ?? THUMBNAIL_CONCURRENCY));

  /** Insertion-ordered: the first key is the least recently used. */
  const urls = new Map<string, string>();
  const inFlight = new Map<string, Promise<string | undefined>>();

  function touch(key: string, url: string): void {
    urls.delete(key);
    urls.set(key, url);
    while (urls.size > maxEntries) {
      const oldest = urls.keys().next();
      if (oldest.done) break;
      const staleUrl = urls.get(oldest.value);
      urls.delete(oldest.value);
      if (staleUrl) revoke(staleUrl);
    }
  }

  return {
    peek(key) {
      return urls.get(key);
    },

    async get(key, source) {
      const cached = urls.get(key);
      if (cached) {
        touch(key, cached);
        return cached;
      }

      const pending = inFlight.get(key);
      if (pending) return pending;

      const work = limit(() => renderThumbnail(source, size, type))
        .then((url) => {
          if (url) touch(key, url);
          return url;
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight.delete(key);
        });

      inFlight.set(key, work);
      return work;
    },

    delete(key) {
      const url = urls.get(key);
      urls.delete(key);
      inFlight.delete(key);
      if (url) revoke(url);
    },

    clear() {
      for (const url of urls.values()) revoke(url);
      urls.clear();
      inFlight.clear();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/** Decode-to-scale, paint, encode. Returns `undefined` when unsupported. */
export async function renderThumbnail(
  source: Blob,
  size = THUMBNAIL_SIZE,
  type = 'image/webp',
): Promise<string | undefined> {
  const bitmap = await decodeScaled(source, size);
  if (!bitmap) return undefined;

  try {
    const box = containSize(bitmap.width, bitmap.height, size);
    const canvas = createCanvas(box.width, box.height);
    const context = context2d(canvas);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, box.width, box.height);

    const blob = await canvasToBlob(canvas, type, 0.8).catch(() =>
      canvasToBlob(canvas, 'image/png'),
    );
    return typeof URL === 'undefined' ? undefined : URL.createObjectURL(blob);
  } finally {
    bitmap.close();
  }
}

/**
 * Ask the browser to decode straight to ~`size` px wide.
 *
 * Only `resizeWidth` is given so the aspect ratio is preserved. A very tall
 * image therefore comes back taller than `size`; the caller's contain-fit draw
 * takes care of that, and the intermediate is still bounded by `size` px wide.
 */
async function decodeScaled(source: Blob, size: number): Promise<ImageBitmap | undefined> {
  if (typeof createImageBitmap !== 'function') return undefined;
  try {
    return await createImageBitmap(source, {
      resizeWidth: size,
      resizeQuality: 'medium',
    });
  } catch {
    // Older Safari rejects resize options outright; retry unscaled before
    // giving up (costs a full decode, but only for that one browser).
    try {
      return await createImageBitmap(source);
    } catch {
      return undefined;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function revoke(url: string): void {
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url);
  }
}

/** Tiny promise-concurrency limiter — a queue of thunks, `max` running. */
function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = (): void => {
    active--;
    const next = waiting.shift();
    if (next) next();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active++;
    try {
      return await task();
    } finally {
      release();
    }
  };
}
