# Changelog

All notable changes to this project are documented in this file. The project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

There is no `Unreleased` section: the open [release pull
request](https://github.com/RamaHerbin/squish/pulls?q=is%3Apr+label%3A%22autorelease%3A+pending%22)
is it. release-please opens that PR from the Conventional Commits landed on `main` and
drafts the section below from their subjects; the prose you are reading is that draft
after a pass by hand, which is where the [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/) sub-headings and the thematic grouping
come from. Editing the section in the release PR is part of cutting a release, not an
optional extra — see CONTRIBUTING.md.

## [0.2.0](https://github.com/RamaHerbin/squish/compare/v0.1.0...v0.2.0) (2026-10-21)


### Added

* **demo:** a real 10-bit PQ HDR sample ([#10](https://github.com/RamaHerbin/squish/issues/10)) ([9fcc168](https://github.com/RamaHerbin/squish/commit/9fcc1688777bf849cf788034bc12b51cc94cc668))
* **demo:** restyle the bundled samples as one editorial series ([#9](https://github.com/RamaHerbin/squish/issues/9)) ([e6d2ae3](https://github.com/RamaHerbin/squish/commit/e6d2ae36e4b95085a3eb504d6730a1e451c9bdbb))
* native macOS app (Tauri 2) ([#3](https://github.com/RamaHerbin/squish/issues/3)) ([4685019](https://github.com/RamaHerbin/squish/commit/468501966f36b891afa300bcaddc94c4f385ce35))
* **pdf:** full-page before/after preview ([#20](https://github.com/RamaHerbin/squish/issues/20)) ([e6cc14d](https://github.com/RamaHerbin/squish/commit/e6cc14d012df4984ef5275d7670322d34e2ea8b3))
* **pdf:** PDF compression UI — analysis, settings, compress, download ([#18](https://github.com/RamaHerbin/squish/issues/18)) ([ab8aa5f](https://github.com/RamaHerbin/squish/commit/ab8aa5f78fea810652e5f5060b926a6cb1fea99b))
* **pdf:** PDF image-compression engine — analysis + recompress (WIP) ([#13](https://github.com/RamaHerbin/squish/issues/13)) ([59ce59c](https://github.com/RamaHerbin/squish/commit/59ce59c2a475145ed97dcfb1754b218505d988c7))
* **share:** send a compressed file to the system share sheet ([#24](https://github.com/RamaHerbin/squish/issues/24)) ([3b4dd7d](https://github.com/RamaHerbin/squish/commit/3b4dd7d5ffab7c96502e3ce22a07fff1ca1b21b4))
* **ui:** cursor-flair hover bloom on the home pill buttons ([#7](https://github.com/RamaHerbin/squish/issues/7)) ([9bdb346](https://github.com/RamaHerbin/squish/commit/9bdb346fda1570c6e62a3b279a83a0d3f869e091))


### Fixed

* **ci:** npm ci lockfile validation on Linux runners ([#6](https://github.com/RamaHerbin/squish/issues/6)) ([d5e7659](https://github.com/RamaHerbin/squish/commit/d5e765930789ab5214cbb379e0e4a44a84f112fa))
* **codecs:** decode iPhone-screenshot HEICs correctly, via libheif 1.22.2 ([#25](https://github.com/RamaHerbin/squish/issues/25)) ([9bf2c0e](https://github.com/RamaHerbin/squish/commit/9bf2c0efcdc8cd46b205ec532537a13183a0c7bf))
* **editor:** remove the Auto-suggest pill ([#27](https://github.com/RamaHerbin/squish/issues/27)) ([712642b](https://github.com/RamaHerbin/squish/commit/712642b240ad50501d71e846f871dba00a9976c7))
* **pdf:** accept shared PDFs, and stop the Paste button lying about them ([#23](https://github.com/RamaHerbin/squish/issues/23)) ([2392565](https://github.com/RamaHerbin/squish/commit/23925654e41554cbe461d84c1cd5ae4d2a6aaf36))
* **pdf:** one Close, and compress without being asked ([#21](https://github.com/RamaHerbin/squish/issues/21)) ([41067d0](https://github.com/RamaHerbin/squish/commit/41067d0c2b07ab29012dfebf817161d64dc39273))
* **pwa:** reload the page when the update toast's Reload is clicked ([#8](https://github.com/RamaHerbin/squish/issues/8)) ([f1d46e9](https://github.com/RamaHerbin/squish/commit/f1d46e9d934ce04b386706af97222c8d03ae40a1))
* repair COEP-less cached pthread workers killing threaded codecs ([#19](https://github.com/RamaHerbin/squish/issues/19)) ([81e4d3c](https://github.com/RamaHerbin/squish/commit/81e4d3cb974edc01c33de8f7f42b8f2679591a26))
* surface codec-worker failures and preserve wide-gamut display ([#12](https://github.com/RamaHerbin/squish/issues/12)) ([355a587](https://github.com/RamaHerbin/squish/commit/355a58716aa0913c8a0d3ad8c0015d9aabb196db))

## [0.1.0] — 2026-07-25

Initial public release. Pinch is a client-side image compressor: every codec runs in
WebAssembly in the browser, and no image is ever uploaded.

### Added

**Compression**

- Six WebAssembly encoders via [jSquash](https://github.com/jamsinclair/jSquash): AVIF,
  JPEG XL, WebP, MozJPEG, OxiPNG and QOI. Each codec is dynamically imported on first
  use, so selecting one never downloads the others.
- Three browser canvas encoders — PNG, JPEG and WebP — each probed at runtime by
  encoding a 1×1 image and checking the returned blob's type, and hidden from the list
  when unsupported.
- An `identity` pass-through side that hands back the original file untouched.
- Per-encoder advanced options, exposed through a toolbar knob, a mobile sheet and an
  advanced drawer that all read one source of truth.

**Input**

- Decode chain: WebCodecs `ImageDecoder`, then `createImageBitmap`, then an `<img>`
  element, with a WebAssembly fallback for AVIF, JPEG XL, WebP, JPEG, PNG and QOI. Both
  paths are attempted before an error is reported.
- HEIC/HEIF input through libheif (`heic-decode` / `libheif-js`), served from a
  runtime-cached chunk rather than the precached shell.
- SVG input, rasterised from retained markup so a resize re-renders the vector at the
  target size instead of upscaling pixels.
- MIME sniffing from magic numbers, ahead of `File.type` and the filename, with an
  explicit error for PDFs.
- HDR detection and labelling: PQ and HLG from the CICP transfer characteristic in
  ISO-BMFF containers, plus gain-map HDR (Ultra HDR JPEG, Apple HEIC). Pixels are
  tone-mapped to SDR and the UI says so.

**Comparing and measuring**

- Reveal compare: one canvas, a draggable divider between the original and the encode,
  under a single shared pan/zoom, aligned even when one side has been resized.
- SSIM computed in a dedicated worker — single-scale, Rec.709 luma, 8×8 non-overlapping
  windows, images box-averaged to a 2 MP budget — reported with plain-language verdicts
  and an honest `Unmeasured` when the pixel grids differ.
- Auto-suggest: binary-searches the lowest quality reaching an SSIM target (0.99 by
  default) between q30 and q95 in at most six encodes, and explains its choice in a
  sentence.
- Codec matrix: MozJPEG, WebP, AVIF, JPEG XL and OxiPNG × four steps = 20 cells of size,
  savings, SSIM and verdict, with one recommended cell that can be applied directly.
  Rows are dealt to worker lanes so each lane keeps one codec warm.

**Batch**

- Queue accepting multi-file pickers, folder pickers and recursive folder drops, bounded
  at 5000 files, 16 directory levels and 50 MB per file.
- Bounded parallelism: `hardwareConcurrency - 2` lanes, clamped to 8, each owning its own
  worker. A failing item is marked and its lane moves on.
- Encoded results staged to the Origin Private File System, keeping memory flat on large
  runs and degrading to in-memory when OPFS is unavailable.
- ZIP export in store mode, streamed, preserving the source folder structure and
  de-duplicating colliding paths.

**Editing and workflow**

- Rotate by 90° steps and crop, shared by both sides of the compare.
- Resize with the wasm resizer or the browser's canvas kernels, with contain/stretch fit.
- Multi-file tabs, each owning its own job engine, so switching tabs never re-decodes and
  background encodes keep running.
- Presets: four built-ins, user presets in IndexedDB, JSON import/export, and shareable
  `?p=` links (deflate-raw + base64url, strictly re-validated on read).
- App settings — default encoder, auto-suggest, worker threads — persisted to IndexedDB
  and sanitised on read.

**Platform**

- Installable, offline-capable PWA with a two-tier cache: shell precache plus a
  `CacheFirst` runtime tier for codec payloads.
- OS share target ("Share to Pinch") and file handlers ("Open with Pinch").
- Explicit update prompt: a new service worker installs and waits until you click
  Reload.
- COOP/COEP headers on the dev and preview servers, enabling `SharedArrayBuffer` and
  therefore threaded WebAssembly codecs.

**Engineering**

- Job engine with pure work diffing, a four-step pipeline (decode → preprocess →
  process → encode), hierarchical aborts and a five-entry LRU result cache for instant
  quality scrubbing.
- Worker bridge where abort means terminate, with one worker per editor side, batch lane
  and matrix lane so cancelling one never discards another's warm wasm.
- A dependency-free contracts layer as the single source of truth for encoder ids,
  option shapes, MIME tables and job state.
- 400+ unit tests running in Node under vitest, plus `svelte-check` against a strict
  TypeScript configuration.

### Known limitations

- No HEIC or HDR encoding — HEVC is patent-encumbered and there is no maintained wasm
  encoder; the pipeline is 8-bit sRGB throughout.
- No palette quantization or dithering — libimagequant is GPL-3.0-or-later and this app
  is MIT. The toolbar switch is a disabled placeholder.
- EXIF metadata does not survive re-encoding. The "Keep EXIF metadata" setting records a
  preference but has no effect on output yet.
- SSIM is unavailable when resize is enabled, because the pixel grids no longer
  correspond.
- English only; no localisation layer.

[0.1.0]: https://github.com/RamaHerbin/squish/releases/tag/v0.1.0
