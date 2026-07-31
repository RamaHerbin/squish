# Architecture

How Pinch is put together, and why. Every file path below is real; read the module
doc comment at the top of each one for the version that ages with the code.

```
src/
├─ App.svelte                 composition root: router, tabs, DI, start-up
├─ main.ts
└─ lib/
   ├─ contracts/              types + pure helpers. Imports nothing outside this dir.
   ├─ codecs/                 the codec worker, its bridge, decode chain, capabilities
   ├─ state/                  the job engine (diff → pipeline → cache), app/tab state
   ├─ metrics/                SSIM worker + client, auto-suggest search
   ├─ matrix/                 the codec sweep
   ├─ batch/                  queue, lanes, OPFS staging, zip export
   ├─ presets/                preset library, URL token codec
   ├─ compare/                reveal divider, pinch-zoom, output canvas
   ├─ edit/                   crop/rotate UI state and geometry
   ├─ options/                encoder knobs, toolbar, advanced drawer
   ├─ settings/               persisted app settings screen
   ├─ shell/                  service worker, share target, tabs, install prompt
   └─ ui/                     design-system primitives
```

The dependency rule is one-directional: `contracts` ← `codecs` / `state` ← features ←
`App.svelte`. Nothing under `lib/` imports `App.svelte`, `state/` never imports
`codecs/`, and `contracts/` imports nothing at all. Where a feature needs a capability
from another layer it is *injected* — a worker-bridge factory, a metrics function, an
encode callback — which is also what makes almost all of it testable in Node.

---

## 1. Contracts: the source of truth

`src/lib/contracts/` is dependency-free by construction: types, constants and small pure
functions, no DOM, no Svelte, no wasm. Anything that two layers must agree on lives here
exactly once.

| File | Owns |
| --- | --- |
| `codecs.ts` | `EncoderId` union, per-encoder option shapes, `DEFAULT_ENCODER_OPTIONS`, quality ranges, `EncoderRegistry`/`EncoderModule` interfaces |
| `image.ts` | MIME sniffing (magic-number table ported from Squoosh), extension tables, `MAX_FILE_BYTES`, `SourceImage`, `HdrInfo` |
| `processing.ts` | `SideSettings` (a discriminated union keyed by `encoderId`), resize/rotate/crop state, structural equality helpers |
| `jobs.ts` | `JobEngine` interface, `JobEngineState`, abort helpers (`assertSignal`, `abortable`, `createAbortError`), `JOB_DEBOUNCE_MS = 100`, `RESULT_CACHE_SIZE = 5` |
| `worker.ts` | The worker protocol: `WorkerApi`, `WorkerBridgeApi`, `TransferableImageData`, `WorkerDecodableMimeType` |
| `batch.ts` | `BatchItem`/`BatchQueue`, `DEFAULT_BATCH_CONCURRENCY = 4`, `BATCH_ZIP_FILENAME = 'squished.zip'` |
| `presets.ts` | `Preset`, the URL token pipeline description, and the strict validators |
| `pinch.ts` | Shell contracts: `AppView`, `TabsApi`, `MetricsResult`, `Verdict` + `THRESHOLDS`, matrix types, `AppSettings` |

Two consequences worth knowing:

**`SideSettings` is a discriminated union.** `encoderId: 'avif'` implies
`encoderOptions: AvifEncodeOptions`. That is why the encoder switch in
`state/engine.ts` is written as an exhaustive `switch` rather than a lookup table:
adding an encoder to the contract makes the engine fail to compile, which is the
intent.

**Untrusted input is validated here, not at the call site.** `isPreset` /
`isSideSettings` (`contracts/presets.ts`) check structure *and* per-encoder option
shape — unknown keys, changed types and non-finite numbers are all rejected, because
encoder options are handed straight to wasm.

---

## 2. Codec worker and bridge

### The worker

`src/lib/codecs/codec.worker.ts` is where every wasm call happens. It exposes five
methods over Comlink — `decode`, `encode`, `resize`, `rotate` and `preload` — and
imports nothing eagerly:

```ts
const loadAvifEncoder = () => loadOnce('enc:avif', () => import('@jsquash/avif/encode'));
```

`loadOnce` memoises the dynamic import, so a codec is instantiated once per worker and
stays warm; a *failed* load is evicted so a transient chunk error does not permanently
disable an encoder. Selecting AVIF therefore never downloads the JPEG XL build, and
Vite emits one chunk per codec.

Before any codec is imported, the worker calls `applyNestedWorkerWorkaround()`
(`codecs/capabilities.ts`). Safari 16.0–16.3 reports wasm-threads support but cannot
spawn the nested workers emscripten's pthread pool needs. jSquash decides between
single- and multi-threaded builds internally via `wasm-feature-detect`'s `threads()`,
which only looks at `SharedArrayBuffer`, and offers no override — so the workaround
deletes `SharedArrayBuffer` from the worker's global scope, which makes that probe
report `false` and selects the single-threaded build.

It also takes a `force` argument, for the case no probe can see coming: a browser that
*can* spawn nested workers but **refuses this particular script**, because the response
it has cached carries no `Cross-Origin-Embedder-Policy`. There is nothing to detect
ahead of time there — the bridge finds out by watching a worker die, and asks for the
retry by putting `?nothreads=1` (`SINGLE_THREADED_PARAM`) on the new worker's own URL.
That query string is the only channel available: jSquash fixes its choice at first
codec init, so the decision has to be made in a *fresh* worker before any message could
have arrived.

### The bridge

`src/lib/codecs/bridge.ts` is the main-thread half, ported from Squoosh's
`worker-bridge` with the same three behaviours (plus a fourth of our own):

1. **Lazy spawn, idle terminate.** No worker exists until the first call; after
   `WORKER_IDLE_TIMEOUT_MS` (10 s) of silence it is terminated, so a tab left open on a
   finished image is not holding warm wasm heaps.
2. **Serialisation.** Every call queues behind the previous one. wasm codecs allocate
   aggressively and are single-threaded per module; two concurrent encodes in one worker
   is how a phone gets OOM-killed.
3. **Abort is terminate.** A wasm call cannot be interrupted once it has entered the
   module. The only real cancellation is `worker.terminate()`, so that is what an
   `AbortSignal` does here: kill the worker, reject everything in flight with an
   `AbortError`, spawn a fresh one on the next call.
4. **One silent fall back to single-threaded.** Comlink never observes a worker that
   fails to load — the message simply goes nowhere and the call hangs — so the bridge
   listens for `error`/`messageerror` itself. The *first* such failure is not reported
   to anyone: it latches `threadsBroken`, respawns with `?nothreads=1`, and re-runs the
   same call. A slower encode beats a dead app, and "a copy of a worker script in your
   HTTP cache predates COOP/COEP" is not something a user can act on. Only a failure
   *after* the latch surfaces, as a `WorkerLoadError`. The latch is one-way and
   per-bridge; there is no third attempt.

   `decode` opts out of the retry (`retryable: false`): its `ArrayBuffer` was
   transferred into the dead worker and is detached, so a second attempt would throw
   `DataCloneError` over the real reason. It costs nothing — jSquash ships `_mt` builds
   for *encoders* only, so a decode never reaches the code path the retry exists for.

   The failure event is read structurally rather than with `instanceof ErrorEvent`, and
   a bare `Event` is translated instead of stringified: `String(event)` is
   `"[object Event]"`, which is precisely the message that made the production outage
   undiagnosable for as long as it lasted.

Because terminate throws away every warm codec in that worker, **each editor side gets
its own bridge** — otherwise aborting side 1's slider drag would discard side 0's
freshly initialised encoder. The same rule applies to batch lanes and matrix lanes.

Copy semantics are explicit: `encode`/`resize`/`rotate` receive an `ImageData` the
caller still owns, so pixels go by structured clone; results come back *transferred*,
since the worker's copy is disposable. `decode` transfers its `ArrayBuffer` in — the
compressed bytes are read fresh off a `File` and consumed — so the caller must not
reuse that buffer.

`state/engine.ts` guards the contract with `assertNotDetached()`: if a bridge
transfers pixels it was only lent, `byteLength` collapses to 0 and every later use
silently renders black. The assertion turns that into a loud error naming the step.

### The decode chain

`src/lib/codecs/decode.ts`, in order:

1. **Sniff** the first 32 bytes (`MIME_SNIFF_BYTES`). `File.type` is whatever the OS
   guessed from the extension, and is empty for anything dragged out of a zip.
   A PDF is recognised explicitly so the error can say something useful.
2. **HDR detect** (`codecs/hdr.ts`) over the first 256 KB, independently of which
   decoder ends up producing pixels.
3. **Decode.** WebCodecs `ImageDecoder` if present, else `createImageBitmap`, else an
   `<img>` element. For AVIF/JXL/WebP/JPEG/PNG/QOI/HEIC/HEIF the worker can decode what
   the browser refuses; if the browser cannot decode the type natively the wasm path
   goes first and the browser second. Either way both are tried before failing — a
   browser that advertises AVIF can still choke on an exotic AVIF, and libavif usually
   copes.

SVG takes a separate route entirely: `normaliseSvg` backfills `width`/`height` from the
`viewBox` (Firefox refuses to draw an SVG without intrinsic size, Chrome draws it
wrong), and the markup is retained on `SourceImage.vector` so a later resize
re-rasterises the vector at the target size instead of resampling a bitmap.

HDR detection (`hdr.ts`) is a bounded byte scan, not a container parse: for ISO-BMFF
it looks for a `colr` box of type `nclx` and reads the CICP transfer characteristic
(16 = PQ, 18 = HLG); for gain-map HDR it looks for the ASCII markers `hdrgm:Version`,
`urn:iso:std:iso:ts:21496` and Apple's `hdrgainmap` urn. Detection never touches
pixels — the decoded buffer is 8-bit sRGB, tone-mapped by whichever decoder ran, and
the UI labels the source `HDR (PQ)` / `HDR (HLG)` / `HDR (gain map)`.

### Capability probes

`src/lib/codecs/capabilities.ts` is importable from the main thread, a worker, or a Node
test — every global is touched behind a `typeof` guard inside a function body. Probes
are memoised per realm. Notable ones:

- `supportsWasmSimd()` / `supportsWasmThreads()` validate two hand-inlined wasm modules
  (byte sequences ported from `wasm-feature-detect`, Apache-2.0, so this file carries no
  dependency into the worker). The threads probe also posts a `SharedArrayBuffer` through
  a `MessageChannel`, because Chrome only permits that transfer under cross-origin
  isolation and pthreads need to hand memory to their workers.
- `canDecodeImageType()` uses the `<picture>`/`<source type>` trick on the main thread
  (the browser only populates `img.currentSrc` from a `<source>` whose type it
  understands, with no network request) and `ImageDecoder.isTypeSupported` in a worker.
- `canEncodeImageType()` encodes a 1×1 image and inspects the *returned* blob's type,
  because Safari and Firefox silently fall back to PNG rather than returning `null`.

---

## 3. The job engine

Split in two on purpose.

**`src/lib/state/engine.ts`** — pure or dependency-injected: work diffing plus the four
pipeline steps. No runes, no DOM, so vitest drives the whole pipeline with a fake bridge.

**`src/lib/state/session.svelte.ts`** — the reactive half: `JobSession`, a Svelte 5
runes store implementing the `JobEngine` contract.

### Two clocks per side

Every side carries both:

- `latestSettings` — what the user has asked for. The controls render from this.
- `encodedSettings` — what produced the pixels currently on screen. Any description
  of those pixels renders from this.

The gap between them *is* the loading affordance. This is the reason a result never
appears to belong to settings that have since changed.

### Work diffing

`planWork(current, desired)` is a pure function returning
`{ needed, decoding, preprocessing, sides: [SideWork, SideWork] }`. Two details matter:

- `current` must describe the **in-flight** job when there is one, not what is on
  screen. Diffing against the screen would restart an encode forever.
- For the `identity` side, per-side processing is meaningless, so
  `effectiveProcessorState()` substitutes a frozen default. A stale resize on an
  abandoned encoder cannot force pointless work.

The pipeline is four steps: **decode → preprocess (rotate, crop) → process (resize) →
encode**, then the encoded file is decoded *back* to pixels for the preview — the point
of a compare view is seeing what the codec actually did, not the pre-encode buffer.

Steps that have nothing to do return the *same object reference* they were given. That
is load-bearing: the result cache matches preprocessed pixels by identity, and a no-op
preprocess that minted a fresh object would blow the cache away every time.

### Hierarchical aborts

One `AbortController` for shared work (decode + preprocess), one per side (process +
encode). Changing side 1's quality never disturbs side 0's in-flight encode — which
matters more than it sounds, because at the worker layer abort means terminate.

A failure is reported once, on the thing that failed: when the shared source fails, the
sides receive a `SourceUnavailableError`, recognise it, and stay quiet instead of
painting the same message three times.

Edits are debounced by `JOB_DEBOUNCE_MS` (100 ms) so a slider drag coalesces; a new
source file bypasses the debounce, since there is nothing to coalesce and the user is
staring at an empty editor.

### The result cache

`src/lib/state/result-cache.ts` — a five-entry LRU (`RESULT_CACHE_SIZE`), ported from
Squoosh. The point is scrubbing: drag quality 75 → 40 → 75 and the third value returns
instantly. Matching rules:

- `preprocessed` by **identity** (`===`) — the engine keeps exactly one preprocessed
  `ImageData` per (source, preprocessorState), so identity is cheaper and stricter than
  a structural check over a few million pixels.
- `processorState` by `processorStateEqual`, so two *disabled* resize configs match even
  when the stale width/height behind the switch differ.
- `encoderOptions` by `shallowEqual`; every option shape is flat.

The cache, the abort controllers, the job snapshots and the raw `ImageData` all live in
private class fields, deliberately **outside** the `$state` proxy: a proxy hands out a
different wrapper on each read, which would quietly destroy the identity match.

### Tabs

`src/lib/shell/tabs.svelte.ts` gives every open image its own `JobEngine`, so switching
tabs never re-decodes and a background encode keeps running. The store never constructs
an engine itself — `App.svelte` injects `createSession`/`disposeSession`, which is how
`contracts` and `shell` stay independent of `state`.

---

## 4. Metrics and auto-suggest

### The metric

`src/lib/metrics/ssim.ts` is pure and dependency-free — it reads
`{ data, width, height }` and returns numbers, so it runs under vitest in Node with
hand-built pixel arrays.

Single-scale SSIM on the Rec.709 luma plane, 8×8 windows at stride 8
(non-overlapping), standard constants (K1 = 0.01, K2 = 0.03, L = 255), population
moments, arithmetic mean over windows. Alpha is composited over white first, because
encoding a transparent source to an opaque format keeps the hidden RGB values and
ignoring alpha would score that pair near-identical while the render is visibly
different.

Deliberately not multi-scale and not Gaussian-weighted: this runs on every slider commit
and on 20 matrix cells, and the extra fidelity buys nothing a user can act on. Above
`METRICS_MAX_PIXELS` (2,000,000) both images are box-averaged down by a single **integer**
factor derived from the dimensions — integer so the reduction is an exact box average,
derived once so both images stay aligned pixel for pixel.

### The worker

`src/lib/metrics/metrics.worker.ts` deliberately does **not** use Comlink: it has a
single call, so a bare `postMessage` protocol keeps the worker chunk down to `ssim.ts`
and nothing else. `metrics-client.ts` mirrors the codec bridge — lazy spawn, 10 s idle
terminate, one comparison at a time, abort-is-terminate — but respawning is free here,
because the worker is stateless with no wasm to re-warm.

Inputs are transferred *in*, so the client sends copies and the caller keeps its decoded
original and preview pixels intact. `measure()` only ever rejects on abort; everything
else (mismatched dimensions because resize is on, a broken worker) resolves as
`{ ssim: null, error }`, because "could not measure" is a displayable state (`SSIM —`),
not an exception.

### Auto-suggest

`src/lib/metrics/auto-suggest.ts` encodes nothing and measures nothing itself: both
capabilities are injected, which is what keeps the search free of any import from
`state/` or `codecs/` and testable with two fakes.

SSIM is monotone non-decreasing in quality for every encoder shipped here, so the
smallest acceptable quality is a binary-search boundary. Defaults
(`AUTO_SUGGEST_DEFAULTS`): target SSIM 0.99, range q30–q95, at most 6 probes — each
probe one encode plus one measurement. If nothing in range clears the target, the best
probe seen is returned with `met: false`, so the pill can say what actually happened
rather than rejecting.

`AutoSuggestController.svelte.ts` owns only the *state* of a suggestion (running / done
/ failed, the sentence, whether the user applied it). Runs supersede each other: calling
`run()` again aborts the one in flight and a late result from a superseded run is
dropped rather than flashing on screen.

---

## 5. The matrix sweep

`src/lib/matrix/sweep.svelte.ts`. Five rows (`MATRIX_ENCODERS`: MozJPEG, WebP, AVIF,
JPEG XL, OxiPNG) × four columns (`MATRIX_QUALITY_STEPS` = 30/50/70/90) = 20 encodes.
OxiPNG is lossless, so its columns are effort levels (`MATRIX_EFFORT_STEPS` = 0/2/4/6),
and the table says so. QOI and the `browser-*` encoders sit out — no meaningful quality
axis, or the same format with less control — and remain pickable in the editor.

**Rows are dealt to lanes, not cells.** Lane `n` takes rows `n`, `n + lanes`, … so a
lane stays on one codec for four consecutive encodes: one wasm module loaded, kept warm,
instead of five thrashing. Lane count is the app-wide `workerThreads` setting, clamped to
`[1, MAX_MATRIX_CONCURRENCY = 8]` and to the number of rows.

SSIM is **injected** (`MatrixMetricsFn`) — this module never implements a perceptual
metric. Each encode is decoded back through the same lane bridge and handed to the
metric with the source pixels. With no metrics function every `ssim` is `null`, every
verdict reads `Unmeasured`, and `pickRecommended()` falls back to a documented
heuristic (a quality floor of 50, plus every lossless cell, then smallest wins).

With SSIM, the recommendation is "the smallest encode still at or above
`THRESHOLDS.good` (0.985)", preferring cells that save at least
`THRESHOLDS.savingsFloor` (5%), ties broken by SSIM then row/column order. If nothing
clears the threshold it keeps the single best-scoring cell rather than pretending.

The encode plan — including the `SideSettings` posted to a worker — is kept in a
private, **unproxied** array: a Svelte proxy is not structured-cloneable and posting one
throws `DataCloneError`. The reactive cells carry their own plain copies, and
`settingsAt()` hands callers a fresh clone.

Cancelling aborts the run controller *and* terminates every lane worker. Cells that
never ran return to `pending` and stay on screen; finished cells keep their numbers.
Every write is guarded on run identity, so a late lane from a cancelled run can never
write into the new table.

---

## 6. Batch

### Ingestion

`src/lib/batch/files.ts` normalises three entry points — `<input multiple>`,
`<input webkitdirectory>` and a folder drop (recursing `webkitGetAsEntry`) — to a
`PickedFile { file, path }`, where `path` is the relative path the file keeps inside the
exported zip.

Bounds: `DEFAULT_MAX_FILES = 5000`, `DEFAULT_MAX_DEPTH = 16`, plus the app-wide
`MAX_FILE_BYTES` (50 MB) per file, so a dropped `node_modules` cannot hang the tab.
`sanitizeZipPath()` strips drive letters, `.`/`..` segments and leading slashes — zip
slip costs nothing to close off. A `DataTransfer` is snapshotted synchronously before
the first `await`, because `DataTransfer.items` is neutered as soon as the drop handler
yields.

### Lanes

`src/lib/batch/queue.svelte.ts` runs `navigator.hardwareConcurrency - 2` lanes, clamped
to `[1, MAX_BATCH_CONCURRENCY = 8]`. Two cores are left for the compositor and the main
thread, because a batch that pins every core makes the page feel broken even while it is
working perfectly. Each lane owns a private bridge, for the usual reason.

A failing item is marked `error` and its lane moves on — one corrupt file in a drop of
200 must not cost the user the other 199. Cancelling aborts the run signal, terminates
every lane worker and returns in-flight items to `pending`; `done` items keep their
results. Each item gets a child `AbortController` linked to the run signal, so a
500-file run does not accumulate 500 listeners on one long-lived signal.

The per-item pipeline (`batch/pipeline.ts`) is deliberately *not* the editor's job
engine: no cache, no debounce, no preprocessor, because rotate and crop are per-image
decisions that make no sense applied blindly to 200 files. What it shares is the abort
discipline.

### OPFS staging

`src/lib/batch/opfs.ts`. A 300-file batch produces 300 encoded blobs, which live in the
renderer heap until export — on a phone, that is how the tab dies. Each result is
written to the Origin Private File System and the `File` returned by
`FileSystemFileHandle.getFile()` is handed back instead: a lazy, disk-backed handle, so
`URL.createObjectURL()`, `file.stream()` and per-item download all keep working while
memory stays flat.

Inputs are **not** staged by default — a `File` from `<input>` or a drop is already a
disk-backed handle owned by the browser, so copying it would double disk traffic for no
memory win. `stageInputs` exists for the one case that pays: guarding against the user
moving or deleting sources mid-run.

Staging is an optimisation, never a correctness requirement: every operation degrades to
"return the file you gave me" when OPFS is missing, out of quota, or throws. Sessions
live under `squish-batch/session-…`, and sessions older than `STAGE_STALE_MS` (12 h) are
swept on startup so a tab crash does not leak disk forever.

### Zip

`src/lib/batch/zip.ts` uses fflate in **store mode (level 0)** by default: the payload is
already-compressed image data, so deflating burns CPU for roughly nothing. That also
means the synchronous `ZipPassThrough` is enough — no worker, no CSP surprises.

Streaming twice over: each output is read chunk by chunk from its blob (disk-backed when
staged, so the bytes never all sit in memory), and the archive accumulates as
`Uint8Array` parts handed to the final `Blob`. Folder structure survives — an item named
`holiday/2024/beach.jpg` encoded to WebP lands at `holiday/2024/beach.webp` — with
` (2)` suffixes when two source folders collapse to the same path.

---

## 7. Presets

`src/lib/presets/`. A preset is one side's settings and nothing else — no source image,
no dimensions — which keeps it applicable to any image and small enough to survive a URL.

The library is backed by `idb-keyval` in its own database, seeded once with four
built-ins (`presets/builtin.ts`) under a `preset:` key prefix, with the "have we seeded"
flag under a reserved `meta:` key so it can never be mistaken for a user preset.

URL sharing (`presets/codec.ts`):

```
Preset → JSON.stringify → TextEncoder → CompressionStream('deflate-raw') → base64url
```

written to `?p=TOKEN` (a `#…?p=TOKEN` fragment is also accepted on read). `deflate-raw`
avoids zlib framing and base64url avoids percent-encoding in the address bar, which
keeps typical tokens short. Decoding reverses every step and finishes with `isPreset`,
because a token lifted from a URL is attacker-controlled and its `encoderOptions` are
fed straight to wasm. Both ends are bounded: `MAX_PRESET_TOKEN_BYTES` (2048) before
anything is touched, and `MAX_PRESET_JSON_BYTES` (64 KB) on the decompressed payload, so
a tiny highly-compressible token cannot balloon in memory.

Presets also export/import as a JSON file (`pinch-presets.json`) from the settings
screen.

---

## 8. PWA and caching

`vite-plugin-pwa` with `strategies: 'injectManifest'`, because the share-target POST
intercept needs a real `fetch` handler that `generateSW`'s declarative config cannot
express. The worker source is `src/lib/shell/sw.ts`.

**Two cache tiers**, mirroring Squoosh's `to-cache.ts` split:

1. **Shell precache** — JS, CSS, HTML, icons and the manifest, listed at build time by
   `injectManifest.globPatterns`, with a 5 MB per-file ceiling. This is what makes the
   app load offline.
2. **Codec runtime tier** — `.wasm` files, plus the `heic-decode-*.js` chunk (a ~1.4 MB
   JS file with the libheif wasm inlined as base64, hence `globIgnores`), are
   deliberately left *out* of the precache and served `CacheFirst` from the
   `squish-wasm-codecs` cache (32 entries, one-year expiry). Codec payloads are large
   and only some are used per session, so the first pick of a codec pays for the fetch
   once and every load after is instant and offline-safe.

**Both tiers carry an admission guard, and both are there because of the same outage.**

The precache tier re-issues every install-time fetch as `cache: 'reload'` and, during
`install` only, reports a cached response with no `Cross-Origin-Embedder-Policy` as a
*miss*. Workbox itself sets `reload` only for entries that carry a revision
(`entry.revision ? 'reload' : 'default'` in `PrecacheController.install`), and
content-hashed assets are emitted with `revision: null` — so it reads them straight out
of the HTTP cache. A returning visitor whose year-old `immutable` copy of
`avif_enc_mt.worker-<hash>.js` predates COOP/COEP therefore had that copy faithfully
re-precached on every install, forever, and no reload could dislodge it. Reporting the
miss is what forces the refetch; `reload` is what also rewrites the HTTP cache entry,
which matters because emscripten's `new Worker()` fetches that URL itself, outside
anything the service worker mediates. The miss is scoped to `install` deliberately —
rejecting a header-less entry at runtime would fall through to the network and make
every offline load a hard failure.

The codec tier checks the *body* against what the URL asked for: `application/wasm` for
`.wasm`, something JavaScript-shaped otherwise, plus `CacheableResponsePlugin({ statuses:
[200] })`. `CacheFirst` is the one workbox strategy with no default cacheability check —
`NetworkFirst` and `StaleWhileRevalidate` both unshift `cacheOkAndOpaquePlugin`, this one
caches whatever comes back — so an HTML fallback served under a codec's URL would be
pinned there for a year and returned ahead of the network on every later visit.
`cleanupOutdatedCaches()` would never sweep it: that only removes precaches from an older
workbox *major* and never touches `squish-wasm-codecs`. Failing closed costs at most one
refetch per session, since `CacheFirst` still returns the live response.

`registerType: 'prompt'`: a new worker installs and waits, and only takes over when the
user clicks Reload in `UpdateToast.svelte`, which posts `SKIP_WAITING` to the waiting
worker. No silent swap under a half-finished encode.

**Share target.** The manifest declares `share_target.action = '/share-target'`
(POST, `multipart/form-data`, field `image`). There is no page there to receive a POST,
so `sw.ts` intercepts the request, stashes the file in Cache Storage — the one storage
synchronously reachable from both worker and page — and 303-redirects to
`/?share-target`. `shell/share-target.ts` reads it back on the resulting GET, deletes
the cache entry, and cleans the marker out of the URL with `history.replaceState`.

**File handling.** `file_handlers` registers every supported image type, consumed
through `window.launchQueue`. `setConsumer` may per spec never fire on a normal
navigation, so it is raced against a 300 ms timeout rather than awaited.

**Cross-origin isolation.** `vite.config.ts` installs a plugin setting
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` on the dev and preview servers, which is
what makes `SharedArrayBuffer` — and therefore threaded wasm — available. Production
hosting must send the same headers; without them the app degrades to single-threaded
codecs.

---

## 9. Testing

`npm test` runs vitest with no browser: 400+ unit tests across 19 files, colocated with
the code they cover (`*.test.ts` next to the module). That is possible because of the
injection discipline described above — the job engine takes a fake bridge, the matrix
takes a fake metrics function, auto-suggest takes two fakes, and the pure modules
(`ssim.ts`, `rotate.ts`, `reveal.ts`, `pinch-zoom.ts`, everything in `contracts/`) need
nothing at all. One suite opts into jsdom explicitly with
`// @vitest-environment jsdom`.

`npm run check` runs `svelte-check` against a strict tsconfig — `strict` plus
`noUncheckedIndexedAccess`, `isolatedModules` and `verbatimModuleSyntax`.
