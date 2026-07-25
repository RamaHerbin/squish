/**
 * Picks up a file the OS handed to squish at launch, through either of the
 * two PWA entry points declared in `vite.config.ts`'s web app manifest:
 *
 * 1. **Share target** (`share_target`, POST + multipart/form-data) — the
 *    OS "Share" sheet posts the file to `/share-target`. There's no page
 *    there to receive a POST body, so `./sw.ts` intercepts the request in a
 *    `fetch` handler, stashes the file in the Cache Storage API (the one
 *    storage synchronously available to both worker and page), and
 *    303-redirects to `/?share-target`. This module then reads it back from
 *    the same cache key on the resulting (plain GET) page load.
 *
 * 2. **File handling** (`file_handlers`) — the OS "Open with squish" /
 *    default-app association launches the page with
 *    `window.launchQueue.setConsumer(...)` receiving the file handle
 *    directly, no service worker involved.
 *
 * Usage — call once, on startup, before rendering the app:
 *
 * ```ts
 * import { consumeSharedFile } from './lib/shell/share-target';
 *
 * const shared = await consumeSharedFile();
 * if (shared) {
 *   app.setMode('editor'); // or 'batch'
 *   engine.setSource(shared);
 * }
 * ```
 *
 * Both mechanisms are single-shot: a share/launch can only be consumed once
 * per page load (the cache entry is deleted after reading; the launch queue
 * consumer only resolves the first file it sees). Calling this a second time
 * in the same session returns `null`.
 */

const SHARE_TARGET_MARKER = 'share-target';
const SHARE_CACHE_NAME = 'squish-share-target';
const SHARE_CACHE_KEY = '/shared-file';

/** Pure: does this `location.search` carry the marker `sw.ts` redirects to after a share? */
export function hasShareTargetMarker(search: string): boolean {
  return new URLSearchParams(search).has(SHARE_TARGET_MARKER);
}

/** Pure: `search` with the marker removed, leading with `?` iff anything is left. */
export function stripShareTargetMarker(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(SHARE_TARGET_MARKER);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

async function consumeShareTargetCache(): Promise<File | null> {
  if (typeof caches === 'undefined' || typeof location === 'undefined') return null;
  if (!hasShareTargetMarker(location.search)) return null;

  if (typeof history !== 'undefined') {
    const cleanedUrl = location.pathname + stripShareTargetMarker(location.search) + location.hash;
    history.replaceState(null, '', cleanedUrl);
  }

  try {
    const cache = await caches.open(SHARE_CACHE_NAME);
    const response = await cache.match(SHARE_CACHE_KEY);
    if (!response) return null;
    await cache.delete(SHARE_CACHE_KEY);

    const blob = await response.blob();
    const name = decodeURIComponent(response.headers.get('x-file-name') ?? 'shared-image');
    const type = blob.type || response.headers.get('content-type') || '';
    return new File([blob], name, { type });
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* File Handling API                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Minimal local shapes for the File Handling API (`window.launchQueue`) —
 * not yet part of TypeScript's DOM lib, so declared here rather than
 * casting through `any` at every call site.
 */
interface ShellFileSystemFileHandle {
  getFile(): Promise<File>;
}
interface ShellLaunchParams {
  readonly files: readonly ShellFileSystemFileHandle[];
}
interface ShellLaunchQueue {
  setConsumer(consumer: (params: ShellLaunchParams) => void | Promise<void>): void;
}

function getLaunchQueue(): ShellLaunchQueue | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { launchQueue?: ShellLaunchQueue }).launchQueue;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/**
 * `launchQueue.setConsumer` is callback-shaped and (per spec) may simply
 * never fire on a normal navigation, so this races it against a short
 * timeout rather than awaiting it directly — a launch with files resolves
 * near-instantly (`getFile()` on an already-open handle), so 300ms is ample
 * without meaningfully delaying startup on a normal load.
 */
function consumeFileHandlerLaunch(): Promise<File | null> {
  const launchQueue = getLaunchQueue();
  if (!launchQueue) return Promise.resolve(null);

  return withTimeout(
    new Promise<File | null>((resolve) => {
      launchQueue.setConsumer(async (params) => {
        const handle = params.files[0];
        if (!handle) {
          resolve(null);
          return;
        }
        try {
          resolve(await handle.getFile());
        } catch {
          resolve(null);
        }
      });
    }),
    300,
    null,
  );
}

/**
 * Check both PWA launch surfaces for a file the OS handed us, and consume
 * whichever fires first. Call exactly once on startup — see the module doc
 * for the intended usage.
 */
export async function consumeSharedFile(): Promise<File | null> {
  const fromShareTarget = await consumeShareTargetCache();
  if (fromShareTarget) return fromShareTarget;
  return consumeFileHandlerLaunch();
}
