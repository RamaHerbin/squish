# Browser support

Pinch feature-detects everything at runtime and degrades instead of failing. This page
lists what each capability needs, what happens when it is missing, and — importantly —
which rows were actually exercised versus inferred from the code.

## How to read this

- **Verified** — exercised in headless Chromium (Playwright; `playwright-core` is a
  devDependency used for smoke runs). Unit tests run in Node/jsdom and cover logic, not
  browser behaviour.
- **Expected** — derived from the capability checks in the source and from the standards
  each feature depends on. Not tested on that engine.

No claim here is a version-number promise. The app never sniffs a browser to decide what
to offer, with one exception noted below; it asks the platform.

## Feature matrix

| Capability | Chromium (Chrome, Edge, Brave, Arc) | Firefox | Safari (macOS/iOS) | What happens when it is missing |
| --- | --- | --- | --- | --- |
| Core editing (decode, encode, compare, download) | Verified | Expected | Expected | — |
| WebAssembly codecs (AVIF, JXL, WebP, MozJPEG, OxiPNG, QOI) | Verified | Expected | Expected | The encoder list drops to the browser canvas encoders |
| Threaded wasm (`SharedArrayBuffer`) | Verified, needs COOP/COEP | Expected, needs COOP/COEP | Expected, needs COOP/COEP | jSquash selects single-threaded builds; slower, same output |
| wasm SIMD | Verified | Expected | Expected | jSquash selects the non-SIMD build |
| `ImageDecoder` (WebCodecs) decode path | Verified | Expected where shipped | Expected where shipped | Falls back to `createImageBitmap`, then an `<img>` element |
| HEIC / HEIF input | Verified (wasm path) | Expected (wasm path) | Expected (native decode first, wasm fallback) | Nothing — libheif wasm is the fallback everywhere |
| JPEG XL input, and decoding JXL *output* for the preview | Verified (wasm path) | Expected (wasm path) | Expected (wasm path) | Nothing — JXL always decodes through wasm |
| AVIF input | Verified (native, wasm fallback) | Expected (native, wasm fallback) | Expected (native, wasm fallback) | The wasm decoder takes over |
| Browser canvas encoders (PNG / JPEG / WebP) | Verified | Expected | Expected for PNG/JPEG; WebP probed | Each is probed individually and hidden from the list if unsupported |
| SVG input and vector-quality resize | Verified | Expected | Expected | — (requires a document; not available in a worker) |
| HDR detection and labelling | Verified | Expected | Expected | — (a byte scan, no platform API involved) |
| SSIM metrics worker | Verified | Expected | Expected | — (plain arithmetic in a module worker) |
| PDF compression (analyse, recompress, download) | Verified | Expected | Expected | — (pdf-lib plus the same codec worker; no platform API involved) |
| PDF page before/after preview (pdf.js) | Verified | Expected | Expected on 16+ | The run still completes; the preview reports that it could not render |
| Batch queue and ZIP export | Verified | Expected | Expected | — |
| Folder drop (`webkitGetAsEntry` recursion) | Verified | Expected | Expected | Falls back to the flat `DataTransfer.files` list |
| OPFS staging of batch results | Verified | Expected | Expected on recent versions | Results stay in memory; large batches use more RAM |
| Offline / installable PWA | Verified | Partial: service worker yes, install prompt no | Partial: "Add to Home Screen", no `beforeinstallprompt` | The app still runs; it is just not installable that way |
| Share sheet ("Share from Pinch", files) | Expected where the platform has one | No | Expected (macOS and iOS) | The Share button is not rendered; Download is unchanged |
| Share target ("Share to Pinch") | Android / ChromeOS only | No | No | The manifest entry is simply never used |
| File handlers ("Open with Pinch") | Desktop Chromium (installed app) | No | No | Files open the normal way |
| IndexedDB (presets, settings) | Verified | Expected | Expected; unavailable in some private modes | Falls back to in-memory defaults for the session |
| `CompressionStream` (preset share links) | Verified | Expected | Expected | Sharing a preset link fails; saved presets still work |

## The details behind the rows

### Threaded wasm needs cross-origin isolation

`supportsWasmThreads()` (`src/lib/codecs/capabilities.ts`) returns true only when
`SharedArrayBuffer` exists, a `SharedArrayBuffer` can be posted through a
`MessageChannel` (Chrome permits that transfer only under cross-origin isolation, and
emscripten's pthreads need it), and the threads wasm probe validates.

That means the deployment must send:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`vite.config.ts` sets both on the dev and preview servers. Without them nothing breaks —
`crossOriginIsolated` is false, jSquash falls back to single-threaded builds, and encodes
take longer.

### The one browser sniff

`isSafari()` exists in the capability report but nothing in the encode path branches on
it. The real workaround is version-agnostic: Safari 16.0–16.3 reported wasm-threads
support while being unable to spawn the nested workers emscripten's pthread pool needs,
so `applyNestedWorkerWorkaround()` deletes `SharedArrayBuffer` from the *worker's* global
scope when nested workers are unavailable, which makes jSquash's internal probe select
the single-threaded build. It runs before any codec is imported and is a no-op everywhere
that combination is sane.

The same lever is pulled for a second case that no sniff and no probe can reach: a browser
that *can* spawn nested workers but refuses this particular one, because the copy of the
script in its HTTP cache carries no `Cross-Origin-Embedder-Policy`. `Worker` works fine
there, so the only evidence is a worker that already died — `codecs/bridge.ts` watches for
that and respawns with `?nothreads=1`, which makes the new worker apply the workaround with
`force`. Version-agnostic in the same way: it is a reaction to observed behaviour, never to
a user-agent string.

### Decode order

1. `ImageDecoder` (WebCodecs) when present — it works off the main thread and hands back
   a `VideoFrame` with no `<img>` lifecycle to manage.
2. `createImageBitmap`.
3. An `<img>` element (main thread only).

For AVIF, JPEG XL, WebP, JPEG, PNG, QOI, HEIC and HEIF there is also a wasm decoder in
the worker. Whether it goes first depends on `canDecodeImageType()`: if the browser
cannot decode the type natively, wasm leads and the browser is the second attempt;
otherwise the reverse. Either way both are tried before an error, because a browser that
advertises AVIF can still fail on an exotic AVIF file.

JPEG XL and QOI have no native decoder anywhere today, so they always take the wasm
path — including when Pinch decodes its *own* JXL output back to pixels for the preview
canvas and for the SSIM comparison. That works in every browser with WebAssembly.

### HEIC

Safari decodes HEIC natively, so on Apple platforms the native path usually wins and no
extra bytes are downloaded. Everywhere else the file goes through `heic-decode` →
`libheif-js`, shipped as a ~1.4 MB chunk that is runtime-cached on first use rather than
precached (see `src/lib/shell/sw.ts`). Decoding only — there is no HEIC encoder.

### Canvas encoders are probed by output, not by name

`canEncodeImageType()` encodes a 1×1 image and inspects the **returned** blob's type,
because Safari and Firefox silently fall back to PNG instead of returning `null` for a
format they cannot write. An encoder that fails the probe is removed from the editor's
list rather than producing a mislabelled file.

The six wasm encoders are gated on the presence of `WebAssembly` alone
(`wasmEncoderFeatureTest`): jSquash picks its own SIMD/threaded build per codec and
falls back to the baseline build, so a browser either runs all six or none.

### OPFS

Batch results are staged to the Origin Private File System so a large run does not hold
every encoded blob in the heap. `isOpfsSupported()` checks for
`navigator.storage.getDirectory` and `FileSystemFileHandle`. When it is missing — older
Safari, some private-browsing modes — or when any OPFS call throws (quota, permissions),
the store degrades to a pass-through that returns the file it was given. The queue
reports which mode it is in (`stageKind: 'opfs' | 'memory'`).

### PWA surfaces

- **Offline** works wherever service workers do, which is every browser in this table.
- **Install prompt**: `beforeinstallprompt` is Chromium-only. Firefox and Safari have
  their own install/add-to-home-screen affordances outside the page's control, so the
  in-app "Install" button simply does not appear there.
- **Share target** (Web Share Target Level 2, POST + `multipart/form-data`) is supported
  by installed PWAs on Android and ChromeOS. Nothing else implements it.
- **File handlers** (`launchQueue`) are desktop-Chromium-only, and only for an installed
  app. The consumer is raced against a 300 ms timeout, because per spec it may never
  fire on a normal navigation.
- **Share sheet** (outbound: `navigator.share({ files })`) is the reverse direction, and
  it is what puts a compressed file into AirDrop, Mail or Messages on macOS and iOS. See
  below.

### The Share button appears only where it will work

`canShareFiles()` (`src/lib/platform/index.ts`) is asked before the button is rendered at
all — there is no disabled state, because a greyed-out Share advertises something the
browser will never do. It is false in four situations:

- **Firefox**, which implements no part of Web Share Level 2.
- **A type the user agent will not carry.** The browser keeps an allowlist; JPEG XL is on
  nobody's, and AVIF is on some. So flipping the editor's encoder can legitimately make
  the button come and go — it is answering honestly each time.
- **A batch that is too large.** The queue shares its finished outputs as individual
  files rather than the zip, and the browser caps how many it will take. Over the cap the
  button disappears and `Download .zip` is still there.
- **The macOS app.** No share plugin is installed under Tauri, and only `dialog:allow-save`,
  `fs:allow-write-file` and `opener:allow-open-url` are granted. A Share button that
  quietly re-opened the save panel would lie, so there is none. A native
  `NSSharingServicePicker` command would be the way to add one.

Two constraints shape the code. The API needs a **secure context**, so a phone testing
over a LAN IP on plain http gets nothing — use the deployed site or an https tunnel. And
it needs **transient activation**: `shareFiles()` awaits nothing before calling
`navigator.share`, and neither may its callers, or Safari rejects a share whose gesture
has already been spent. That is why the queue never builds a zip for sharing: the build
is async, and the gesture would be gone by the time the sheet was asked for.

### The PDF preview and Safari

Rasterising a page needs pdf.js, and pdf.js 6's default build calls
`Promise.withResolvers`, which Safari only shipped in 17.4. Pinch therefore loads pdf.js
from its `legacy/` build, which bundles the polyfills upstream considers necessary, so
Safari 16 and 17.0-17.3 get a working preview rather than a module that throws on
evaluation. The same choice covers the WKWebView in the macOS app, where
`minimumSystemVersion` is 12.0.

pdf.js renders in its own worker. If that worker cannot start, pdf.js does not throw — it
silently falls back to rasterising on the main thread, which would freeze the tab on a
real document. Pinch checks for that fallback and reports it instead, so a broken preview
says so rather than hanging. Compression itself does not depend on any of this: the run
completes and the file downloads even when the preview cannot draw.

### Storage

Presets and app settings use `idb-keyval`. `idb-keyval`'s `get`/`set` reference the
global `indexedDB` as an eagerly-evaluated default parameter, so calling them at all
throws *synchronously* where the global is absent — both stores check
`typeof indexedDB` before touching the library, and fall back to an in-memory store.
Consequence: in a private mode that blocks IndexedDB, presets and settings work for the
session and are not persisted.

## What is not supported

- **Internet Explorer, and any browser without WebAssembly or ES modules.** The build
  targets `es2022` and the workers are ES modules; there is no legacy bundle.
- **Server-side rendering.** The app is a client-side SPA. Modules touch DOM and worker
  globals only behind `typeof` guards, which is what lets the pure ones run under
  vitest, but nothing here is designed to render on a server.
- **Node.js as a runtime.** There is no CLI.
