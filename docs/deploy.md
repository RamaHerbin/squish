# Deploying Pinch

Pinch is a fully static build. There is no server, no API and no database — `npm run build`
emits `dist/` and any static host can serve it, provided it sends two headers.

Those two headers are the only non-obvious part of the deployment, so they get their own
section below.

---

## 1. Vercel (the reference deployment)

1. Push the repository to GitHub.
2. On [vercel.com](https://vercel.com), **Add New → Project** and import the repo.
3. Framework preset: **Vite**. Leave everything else alone.
4. Deploy.

That is the whole procedure. `vercel.json` at the repo root already declares the build
command (`npm run build`), the output directory (`dist`), the cross-origin isolation
headers, the cache policy and the SPA rewrite — so the dashboard needs no manual
configuration, and preview deployments get the same headers as production.

Vercel's Git integration deploys on push. CI (`.github/workflows/ci.yml`) type-checks, tests
and builds; it deliberately never *pushes* a deployment, so the two never fight over one. It
does read one back: the `deploy` job runs on Vercel's `deployment_status` webhook and points
`scripts/verify-deploy.mjs` at the URL it carries — see
[§3](#3-verifying-a-deployment).

### What `vercel.json` does

| Rule | Effect |
| --- | --- |
| `headers` → `/(.*)` | `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` + `Cross-Origin-Resource-Policy: same-origin` on **every** response |
| `headers` → `/assets/(.*)` | `Cache-Control: public, max-age=31536000, immutable` |
| `headers` → `/sw.js`, `/manifest.webmanifest` | `Cache-Control: public, max-age=0, must-revalidate` |
| `rewrites` → `/((?!assets/).*)` → `/index.html` | SPA fallback, everywhere except the build output |

Notes on those rules:

- **The catch-all header rule is listed first.** Vercel applies every header rule whose
  `source` matches, so `/assets/foo.wasm` picks up both the isolation headers and the
  immutable cache policy. The rules touch disjoint header keys, so there is nothing to
  collide.
- **Header rules match the incoming request path**, before rewrites are applied. The SPA
  rewrite therefore does not interfere with the `/assets/*` cache rule.
- **The SPA rewrite does not shadow real files.** Vercel serves an existing file from the
  output directory before consulting `rewrites`, so `/sw.js`, `/manifest.webmanifest`,
  `/assets/*`, `/icons/*` and `/demo/*` are still served as themselves.
- **…but it did shadow *missing* ones, which is why `/assets/` is excluded from it.** A file
  that is not there never hits the filesystem phase, so a plain `/(.*)` catch-all answered
  `GET /assets/gone-<hash>.js` with `200 text/html` — the SPA shell, under a script URL, with
  a one-year `immutable` lifetime on it. That is how an HTML document ends up precached as a
  codec chunk. The negative lookahead makes the rule simply not match `/assets/*`, so a
  missing build artefact 404s like it should. Note the group is **unnamed**: writing
  `/:path((?!assets/).*)` would append the unused parameter to the destination as
  `/index.html?path=…` and change the CDN cache key on every route.
- **Everything under `/assets/` is content-hashed** by Vite (JS, CSS, `.wasm` and fonts all
  carry a content hash in the filename), which is what makes a one-year immutable lifetime
  safe. `sw.js` and `manifest.webmanifest` are *not* hashed — they keep stable names across
  deploys, so they must revalidate or clients would pin an old service worker and never see
  an update. `index.html` is served by Vercel with a revalidating cache policy by default
  and needs no rule.

---

## 2. Why COOP/COEP is required

Pinch encodes with WebAssembly codecs from [jSquash](https://github.com/jamsinclair/jSquash).
Three of them ship a multi-threaded build alongside the single-threaded one:

| Codec | Single-threaded | Multi-threaded |
| --- | --- | --- |
| AVIF encode | `avif_enc.wasm` | `avif_enc_mt.wasm` (emscripten pthreads) |
| JPEG XL encode | `jxl_enc.wasm` | `jxl_enc_mt.wasm` / `jxl_enc_mt_simd.wasm` (emscripten pthreads) |
| OxiPNG | `codec/pkg` | `codec/pkg-parallel` (wasm-bindgen-rayon) |

MozJPEG, WebP and QOI are single-threaded either way and are unaffected by isolation.

wasm threads need `SharedArrayBuffer`, and browsers only expose `SharedArrayBuffer` in a
**cross-origin isolated** context. A document is cross-origin isolated when its response
carries both:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`src/lib/codecs/capabilities.ts` probes for this at runtime (`isCrossOriginIsolated()`,
`supportsWasmThreads()`), and the dev/preview servers set the same two headers through the
`crossOriginIsolation` plugin in `vite.config.ts` — so local development and production
behave identically.

### What happens if you omit them

The app still works. jSquash picks between its single- and multi-threaded builds internally,
via `wasm-feature-detect`'s `threads()` probe, which comes down to whether
`SharedArrayBuffer` exists. Without isolation that probe fails and the single-threaded codec
is selected. The consequence is slower AVIF, JPEG XL and OxiPNG encodes, not a broken page.

It is a performance cliff rather than an outage — which is exactly why it is easy to ship by
accident, and why it is worth verifying explicitly on every deploy rather than assuming.

### The cost of `require-corp`

Under `Cross-Origin-Embedder-Policy: require-corp`, any **cross-origin** subresource is
blocked unless it opts in with `Cross-Origin-Resource-Policy` or CORS. Same-origin
subresources are unaffected.

Pinch currently loads nothing cross-origin — fonts are bundled locally via `@fontsource`
and emitted into `/assets/`, and there are no third-party scripts. If you fork this and add
an external analytics snippet, a CDN font, or an `<iframe>`, expect it to be blocked until
the third party sends the right headers. Choose deliberately: cross-origin isolation or the
third-party embed.

The mirror image, `Cross-Origin-Resource-Policy: same-origin`, is sent on every response
too. Be precise about what it does and does not buy: CORP restricts who may embed *our*
responses, and it is not the header that broke the threaded codecs. The check that refuses
a dedicated worker on an isolated page reads the script response's
**`Cross-Origin-Embedder-Policy`**, and the CORP check passes unconditionally for a
same-origin response — so CORP could not have caused that outage and does not prevent its
return. It is here as ordinary hardening against our own responses being embedded
elsewhere, nothing more. The trade is that other sites can no longer hotlink `/og.png` and
friends as a subresource; social crawlers fetch `og:image` server-side and are unaffected.

---

## 3. Verifying a deployment

All of it at once, against a real origin:

```sh
npm run build
node scripts/verify-deploy.mjs https://pinch.rama.app
```

It enumerates every worker script and every `.wasm` in the local `dist/assets`, asks the
deploy for each one, and fails on anything that is not `200`, with a JavaScript or
`application/wasm` content type, under `require-corp`. It also asks for a path that cannot
exist (`/assets/__missing-probe__.js`) and fails if that answers `200`. Per-asset, not one
`curl -I /`, because the outage this replaces was invisible at the origin root: the header
was right there the whole time and the *cached copies* were the broken ones. CI runs this on
every Vercel deployment; an access-protected preview answers `401` and is skipped, not failed.

The manual equivalents, when you want to look at one thing by hand:

```sh
curl -I https://pinch.rama.app | grep -i cross-origin
```

Expected:

```
cross-origin-opener-policy: same-origin
cross-origin-embedder-policy: require-corp
cross-origin-resource-policy: same-origin
```

Check a hashed asset too, since that is the path a misconfigured host is most likely to get
wrong — pull a real filename out of the deployed HTML rather than guessing a hash:

```sh
ASSET=$(curl -s https://pinch.rama.app/ | grep -o '/assets/[^"]*\.js' | head -1)
curl -I "https://pinch.rama.app$ASSET" | grep -i 'cross-origin\|cache-control'
# expect both isolation headers plus:
# cache-control: public, max-age=31536000, immutable
```

Check the two files that must *not* be cached immutably:

```sh
curl -I https://pinch.rama.app/sw.js | grep -i cache-control
curl -I https://pinch.rama.app/manifest.webmanifest | grep -i cache-control
# both: cache-control: public, max-age=0, must-revalidate
```

Finally, confirm the browser agrees. Open the deployed site, then in the DevTools console:

```js
crossOriginIsolated; // must be true
```

`crossOriginIsolated === true` is the authoritative signal — headers can be present and
still not produce isolation if, for instance, a proxy in front of the host strips or
rewrites them.

A secure context is also required: `SharedArrayBuffer` and service workers only exist over
HTTPS (or on `localhost`). Vercel, Netlify and Cloudflare Pages all serve HTTPS by default.

---

## 4. Other hosts (for forkers)

Netlify and Cloudflare Pages both use the same file-based convention: drop the config files
into `public/`, and Vite copies them verbatim into `dist/` at build time, which is where
those hosts look for them.

### Netlify

`public/_headers`:

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/sw.js
  Cache-Control: public, max-age=0, must-revalidate

/manifest.webmanifest
  Cache-Control: public, max-age=0, must-revalidate
```

`public/_redirects`:

```
/*  /index.html  200
```

Build command `npm run build`, publish directory `dist`. Netlify serves an existing file
before applying a redirect rule, so the catch-all does not shadow `/assets/*` or `/sw.js`.
Do not add the `!` force suffix (`200!`) — that would override the filesystem and break
every asset.

It *will* shadow a `/assets/*` path that does **not** exist, though — see requirement 5
below for why that matters. Netlify takes the first matching rule, so an explicit 404 ahead
of the catch-all is the fix:

```
/assets/*  /assets/:splat  404
/*  /index.html  200
```

### Cloudflare Pages

Identical `public/_headers` and `public/_redirects` files — Cloudflare Pages reads the same
two formats from the build output root. Build command `npm run build`, build output
directory `dist`.

### Anything else (nginx, Caddy, S3 + CloudFront, …)

The requirements are host-agnostic:

1. Serve `dist/` as static files.
2. Send `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp` on every response, including `/sw.js`
   (a service worker script needs compatible headers of its own to be registered from an
   isolated page).
3. Long-lived immutable caching for `/assets/*`; revalidate `sw.js`,
   `manifest.webmanifest` and `index.html`.
4. Fall back to `/index.html` for paths that do not map to a file.
5. **Exempt the build output from that fallback.** A missing `/assets/*` must 404, not
   return the SPA shell at `200 text/html`. Otherwise a stale or wrong hash — a client on
   an old `index.html`, a half-propagated deploy — fetches an HTML document under a `.js`
   or `.wasm` URL, gets it with `max-age=31536000, immutable`, and the service worker
   precaches it there. Every codec that chunk belongs to then fails, in every session,
   until the cache expires a year later. `node scripts/verify-deploy.mjs <origin>` probes
   for exactly this.

---

## 5. Routing footnote: `/share-target`

The web app manifest registers `/share-target` as a Web Share Target (POST,
`multipart/form-data`). No host-side route is needed for it: the service worker
(`src/lib/shell/sw.ts`) intercepts that POST, stashes the shared file in Cache Storage and
303-redirects to a normal `GET /?share-target`.

This means the share target only functions once the service worker is installed, which is
also the only state in which an OS offers Pinch as a share destination. The catch-all SPA
rewrite is irrelevant to it.
