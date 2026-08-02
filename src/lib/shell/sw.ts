/**
 * Custom service worker source (`strategies: 'injectManifest'` in
 * vite.config.ts — see that file's comment for why `generateSW` wasn't
 * enough: the share-target POST intercept below needs a real `fetch`
 * handler, which `generateSW`'s declarative config can't express).
 *
 * Three-tier caching, extending Squoosh's `to-cache.ts` split:
 *   - shell (JS/CSS/HTML/icons) — precached via `precacheAndRoute`, listed
 *     at build time from `injectManifest.globPatterns` in vite.config.ts.
 *   - codec wasm — deliberately left OUT of that precache list (it's large
 *     and only some codecs get used per session) and instead runtime-cached
 *     `CacheFirst` below, so the first pick of a codec pays for the fetch
 *     once and every load after is instant and offline-safe.
 *   - pdf.js — the same deal for the PDF preview's renderer, in a cache of
 *     its own because it is a hundred times more files than the codecs are.
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
 * pdf.js's data files live under one versioned prefix, written by the
 * `pdfjs-assets` plugin in vite.config.ts — 168 CMaps, three wasm decoders and
 * a fallback ICC profile, all fetched by URL from inside the pdf.js worker.
 */
const PDFJS_ASSET_PREFIX = '/assets/pdfjs/';

/** `assets/pdf-<hash>.js`, `assets/pdf.worker-<hash>.mjs`, `.min` variants of both. */
const isPdfJsScript = (pathname: string): boolean => /\/pdf[-.][^/]*\.m?js$/.test(pathname);

/** The subset of those that gets handed to `new Worker()`. */
const isPdfJsWorker = (pathname: string): boolean => /\/pdf\.worker[^/]*\.m?js$/.test(pathname);

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
    const { pathname } = new URL(request.url);
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (pathname.endsWith('.wasm')) {
      return contentType.startsWith('application/wasm') ? response : null;
    }
    if (pathname.endsWith('.js') || pathname.endsWith('.mjs')) {
      // pdf.js's worker is spawned with a real `new Worker()`, so a copy
      // admitted without a header this `require-corp` page accepts would be
      // refused by the browser on every later load — for the whole year of the
      // TTL below, with no reload able to clear it. `precacheCoepRepair` is the
      // repair pass for that mistake in the precache; a runtime cache has none,
      // so the only fix is to never write it. Nothing is lost by refusing: a
      // response the browser won't start a worker from is worth exactly as much
      // offline as it is online. Left off the heic chunk, which is imported
      // rather than spawned — the nested worker heic-to creates comes from a
      // blob: URL and inherits the codec worker's COEP, not this response's.
      const usable = !isPdfJsWorker(pathname) || coepAllowsWorker(response);
      return contentType.includes('javascript') && usable ? response : null;
    }
    // `.bcmap` and `.icc` have no registered media type — hosts answer them
    // with `application/octet-stream`, or with nothing at all — so there is no
    // positive check to make and the original `*javascript*` fallback would
    // have rejected every one of them. What's left to check is the one wrong
    // body that actually turns up, the SPA fallback's `text/html`. `vercel.json`
    // keeps `/assets/` out of that rewrite; this is the belt to those braces.
    return contentType.startsWith('text/html') ? null : response;
  },
};

registerRoute(
  // The heic-to chunk is a ~3 MB JS file carrying libheif compiled to plain
  // JavaScript (Emscripten wasm2js, no separate .wasm fetch) — codec-sized, so
  // it joins the wasm runtime tier (and is globIgnored from the precache
  // manifest in vite.config.ts).
  //
  // pdf.js's three `.wasm` files are excluded by prefix rather than left to
  // registration order. Workbox does match routes in the order they're
  // registered, so putting the pdf.js route first would work — but that is a
  // property nothing in either route states and no later edit would think to
  // preserve, and getting it wrong burns three of the 32 entries below on a
  // payload that has its own cache precisely so it can't.
  ({ url }) =>
    !url.pathname.startsWith(PDFJS_ASSET_PREFIX) &&
    (url.pathname.endsWith('.wasm') ||
      /\/heic-to-[^/]{8}\.js$/.test(url.pathname)),
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
 * pdf.js gets a tier of its own, for the codecs' reason and then one more.
 *
 * Its payload comes in three shapes: the ~430 KB library chunk, the ~2 MB
 * worker script, and the data files under `PDFJS_ASSET_PREFIX`. All of it is
 * globIgnored from the precache — only PDF users need any of it — and none of
 * it matches the codec route above, so without this the PDF preview would be
 * network-only: the one view whose input is a file already sitting on the
 * user's disk would be the one view that needs a connection.
 *
 * The reason it isn't simply `squish-wasm-codecs` is the entry cap. That cache
 * allows 32, sized for a dozen-odd codec binaries that are each fetched once
 * and kept forever. pdf.js can ask for CMaps by the handful per document and
 * would walk past 32 in a session of CJK files, evicting every codec the user
 * had warmed up — after which the two families thrash against each other
 * indefinitely, each eviction paid for again at the next encode. One shared
 * budget cannot serve both access patterns; two budgets cost one cache name.
 */
registerRoute(
  ({ url }) => url.pathname.startsWith(PDFJS_ASSET_PREFIX) || isPdfJsScript(url.pathname),
  new CacheFirst({
    cacheName: 'squish-pdfjs',
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      codecContentTypeGuard,
      // 168 CMaps + 3 wasm + 1 ICC + the library and worker chunks is ~174 URLs
      // for one pdfjs-dist version, and every URL here carries either a content
      // hash or the version, so an upgrade strands the old set rather than
      // overwriting it. 256 leaves an upgrade's overlap room to age out by LRU
      // instead of evicting the version actually in use.
      new ExpirationPlugin({ maxEntries: 256, maxAgeSeconds: 60 * 60 * 24 * 365 }),
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
