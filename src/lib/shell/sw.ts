/**
 * Custom service worker source (`strategies: 'injectManifest'` in
 * vite.config.ts — see that file's comment for why `generateSW` wasn't
 * enough: the share-target POST intercept below needs a real `fetch`
 * handler, which `generateSW`'s declarative config can't express).
 *
 * Two-tier caching, matching Squoosh's `to-cache.ts` split:
 *   - shell (JS/CSS/HTML/icons) — precached via `precacheAndRoute`, listed
 *     at build time from `injectManifest.globPatterns` in vite.config.ts.
 *   - codec wasm — deliberately left OUT of that precache list (it's large
 *     and only some codecs get used per session) and instead runtime-cached
 *     `CacheFirst` below, so the first pick of a codec pays for the fetch
 *     once and every load after is instant and offline-safe.
 */

/// <reference lib="webworker" />

import { cleanupOutdatedCaches, precacheAndRoute, type PrecacheEntry } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<PrecacheEntry | string>;
};

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
clientsClaim();

registerRoute(
  // The heic-decode chunk is a ~1.4 MB JS file with the libheif wasm inlined
  // as base64 — codec-sized, so it joins the wasm runtime tier (and is
  // globIgnored from the precache manifest in vite.config.ts).
  ({ url }) =>
    url.pathname.endsWith('.wasm') ||
    (url.pathname.includes('heic-decode-') && url.pathname.endsWith('.js')),
  new CacheFirst({
    cacheName: 'squish-wasm-codecs',
    plugins: [new ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 365 })],
  }),
);

/**
 * `registerType: 'prompt'` — a new worker installs and waits; it only takes
 * over once the user clicks "Reload" in `UpdateToast.svelte`, which calls
 * `swStatus.reload()` → `updateServiceWorker(true)` → posts this message to
 * the waiting worker (see `sw-registration.svelte.ts`).
 */
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

/* -------------------------------------------------------------------------- */
/* Share target (Web Share Target L2, POST + multipart/form-data)             */
/* -------------------------------------------------------------------------- */
//
// Manifest declares `share_target.action = '/share-target'` (vite.config.ts).
// The browser POSTs the shared file straight to that URL — there's no page
// there to receive it, so this intercepts the request, stashes the file in
// Cache Storage, and 303-redirects to a normal GET. `share-target.ts` reads
// it back on the client from the same cache key.

const SHARE_TARGET_PATH = '/share-target';
const SHARE_CACHE_NAME = 'squish-share-target';
const SHARE_CACHE_KEY = '/shared-file';
/** Must match the `name` in `share_target.params.files` in vite.config.ts. */
const SHARE_FORM_FIELD = 'image';

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === SHARE_TARGET_PATH) {
    event.respondWith(handleShareTarget(event.request));
  }
});

async function handleShareTarget(request: Request): Promise<Response> {
  try {
    const formData = await request.formData();
    const file = formData.get(SHARE_FORM_FIELD);
    if (file instanceof File) {
      const cache = await caches.open(SHARE_CACHE_NAME);
      await cache.put(
        SHARE_CACHE_KEY,
        new Response(file, {
          headers: {
            'content-type': file.type || 'application/octet-stream',
            'x-file-name': encodeURIComponent(file.name || 'shared-image'),
          },
        }),
      );
    }
  } catch {
    // Fall through to the redirect regardless — the client simply finds
    // nothing waiting for it and stays on the intro screen.
  }
  return Response.redirect('/?share-target', 303);
}
