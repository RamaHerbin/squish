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

import {
  addPlugins as addPrecachePlugins,
  cleanupOutdatedCaches,
  precacheAndRoute,
  type PrecacheEntry,
} from 'workbox-precaching';
import { clientsClaim, type WorkboxPlugin } from 'workbox-core';
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { ExpirationPlugin } from 'workbox-expiration';

import { SINGLE_THREADED_PARAM } from '../contracts';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<PrecacheEntry | string>;
};

/**
 * Repairs the precache entry poisoning that killed every THREADED codec
 * (AVIF, JPEG XL, OxiPNG) for long-returning visitors while the
 * single-threaded ones (WebP, MozJPEG) kept working.
 *
 * jSquash's threaded builds spawn a real pthread worker —
 * `new Worker('/assets/avif_enc_mt.worker-<hash>.js')`. On a cross-origin
 * isolated page Chrome refuses to create a dedicated worker whose SCRIPT
 * RESPONSE carries no compatible `Cross-Origin-Embedder-Policy`, and the
 * refusal surfaces as a bare `Event` with no message or filename. Emscripten's
 * glue rethrows that raw object, so all `codecs/bridge.ts` ever sees is
 * "Uncaught [object Event]".
 *
 * The response was stale, never wrong. `vercel.json` pins `/assets/*` as
 * `immutable, max-age=1y`, and those worker scripts are content-hashed: their
 * bytes did not change across the deploy that introduced COOP/COEP, so their
 * URLs did not change either and the browser kept a year-old header-less copy
 * in its HTTP cache — which every precache install then faithfully re-ingested.
 * That is why reloading could never fix it, and why `curl` always looked fine.
 *
 * Two callbacks, because workbox only covers half of this:
 *
 *   - `requestWillFetch` — `PrecacheController.install()` sets `cache: 'reload'`
 *     only for entries that carry a revision (`entry.revision ? 'reload' :
 *     'default'`). Content-hashed assets have `revision: null`, so workbox reads
 *     them straight out of the HTTP cache. Re-issuing every precache fetch as
 *     `reload` closes that hole — and because `reload` also REWRITES the HTTP
 *     cache entry it fixes the copy that the emscripten glue's `new Worker()`
 *     later asks for by URL, which is the load the SW does not mediate.
 *
 *   - `cachedResponseWillBeUsed` — without it the above would never run for the
 *     already-poisoned entries: `PrecacheStrategy._handle` returns early on a
 *     `cacheMatch` hit, and the hashes are unchanged, so the bad entries match
 *     and are never refetched. Reporting them as a miss forces the refetch whose
 *     `cachePut` overwrites them.
 *
 * The miss is reported during `install` only. At runtime a header-less entry is
 * still better than nothing — rejecting it there would fall through to the
 * network and turn every offline load into a hard failure.
 */
const COEP_HEADER = 'cross-origin-embedder-policy';

/**
 * Would a dedicated worker with this script response be allowed to start on a
 * `require-corp` page?
 *
 * Presence is not the test. Chrome accepts `require-corp` and `credentialless`
 * — the latter is a different way to satisfy the same embedder requirement, not
 * a weaker one for this check — and refuses only `unsafe-none`, which is also
 * what an absent header means. Matching on presence alone would report a
 * response carrying the one value that actually fails as healthy and leave it
 * in the cache unrepaired.
 */
function coepAllowsWorker(response: Response): boolean {
  const value = response.headers.get(COEP_HEADER)?.trim().toLowerCase();
  return value === 'require-corp' || value === 'credentialless';
}

const precacheCoepRepair: WorkboxPlugin = {
  async requestWillFetch({ request }) {
    return new Request(request, { cache: 'reload' });
  },
  async cachedResponseWillBeUsed({ cachedResponse, event }) {
    if (event.type === 'install' && cachedResponse && !coepAllowsWorker(cachedResponse)) {
      return null;
    }
    return cachedResponse;
  },
};

// Narrower than the name suggests: it only deletes precaches left behind by an
// older workbox MAJOR (it matches workbox's own legacy cache naming). It never
// touches `squish-wasm-codecs` below — that cache is ours, nothing in workbox
// will ever evict a bad entry from it, and its year-long TTL means anything
// admitted by mistake stays. Hence the admission guards on that route below,
// rather than relying on a sweep that will never come.
cleanupOutdatedCaches();
addPrecachePlugins([precacheCoepRepair]);
// `addPlugins`, not `precacheAndRoute(list, { plugins })` — that second argument
// is `PrecacheRouteOptions` (directoryIndex / cleanURLs / urlManipulation /
// ignoreURLParametersMatching) and has no `plugins` field at all.
//
// It does carry the one option we need, though. The bridge's single-threaded
// retry respawns the codec worker at `?nothreads=1` (see
// `codecs/bridge.ts` → `spawnCodecWorker`), and the precache is keyed on the
// bare content-hashed URL. Workbox strips only the params matching this list
// before looking a request up, and the default — `[/^utm_/, /^fbclid$/]` —
// leaves `nothreads` in place, so the recovery worker would match no route at
// all and have to reach the network. That is exactly backwards: the visitors
// this repair exists for are the ones most likely to be offline in an
// installed PWA. Naming the param here lets the retry hit the same precache
// entry as the first attempt. The two defaults are restated because supplying
// this option replaces them rather than extending them.
precacheAndRoute(self.__WB_MANIFEST, {
  ignoreURLParametersMatching: [/^utm_/, /^fbclid$/, new RegExp(`^${SINGLE_THREADED_PARAM}$`)],
});
clientsClaim();

/**
 * A 200 is not proof of the right body: a misrouted `.wasm` comes back as a
 * perfectly healthy 200 `text/html` (an index.html fallback), which is exactly
 * the shape that pins a year of "bad magic number" under a codec's URL. Check
 * the body against what the URL asked for.
 *
 * Failing closed is cheap here — a `cacheWillUpdate` returning null only skips
 * the write, and `CacheFirst` still hands the live response to the caller. A
 * host that mislabels wasm costs a refetch per session, never a broken codec.
 */
const codecContentTypeGuard: WorkboxPlugin = {
  async cacheWillUpdate({ request, response }) {
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    const expectsWasm = new URL(request.url).pathname.endsWith('.wasm');
    const matches = expectsWasm
      ? contentType.startsWith('application/wasm')
      : contentType.includes('javascript');
    return matches ? response : null;
  },
};

registerRoute(
  // The heic-decode chunk is a ~1.4 MB JS file with the libheif wasm inlined
  // as base64 — codec-sized, so it joins the wasm runtime tier (and is
  // globIgnored from the precache manifest in vite.config.ts).
  ({ url }) =>
    url.pathname.endsWith('.wasm') ||
    (url.pathname.includes('heic-decode-') && url.pathname.endsWith('.js')),
  new CacheFirst({
    cacheName: 'squish-wasm-codecs',
    plugins: [
      // `CacheFirst` is the one strategy workbox ships with NO default
      // cacheability check — `NetworkFirst` and `StaleWhileRevalidate` both
      // unshift `cacheOkAndOpaquePlugin`, this one caches whatever comes back.
      // So a 404 or 5xx body would be pinned under a codec's key for a year and
      // returned ahead of the network on every later visit, with no reload able
      // to clear it.
      new CacheableResponsePlugin({ statuses: [200] }),
      codecContentTypeGuard,
      new ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 365 }),
    ],
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
