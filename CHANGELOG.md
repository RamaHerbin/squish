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

## [0.2.0](https://github.com/RamaHerbin/squish/compare/v0.1.0...v0.2.0) (2026-08-04)


### Added

* **demo:** a real 10-bit PQ HDR sample ([#10](https://github.com/RamaHerbin/squish/issues/10)) ([f4ef1db](https://github.com/RamaHerbin/squish/commit/f4ef1db1b3e6823a88fcf730c6b881d79894b6d6))
* **demo:** restyle the bundled samples as one editorial series ([#9](https://github.com/RamaHerbin/squish/issues/9)) ([30e57fc](https://github.com/RamaHerbin/squish/commit/30e57fc7996c658747379f4d746d52e239412990))
* native macOS app (Tauri 2) ([#3](https://github.com/RamaHerbin/squish/issues/3)) ([6628aa0](https://github.com/RamaHerbin/squish/commit/6628aa0337a6d18713aa3c62f25666dcbfc2af1b))
* **pdf:** full-page before/after preview ([#20](https://github.com/RamaHerbin/squish/issues/20)) ([53f7de3](https://github.com/RamaHerbin/squish/commit/53f7de3e9ca8a93febd073ee502d3423b32113d6))
* **pdf:** PDF compression UI — analysis, settings, compress, download ([#18](https://github.com/RamaHerbin/squish/issues/18)) ([69a46f5](https://github.com/RamaHerbin/squish/commit/69a46f50158fd126ff06d22b735809d00a31fafc))
* **pdf:** PDF image-compression engine — analysis + recompress (WIP) ([#13](https://github.com/RamaHerbin/squish/issues/13)) ([29f5c2a](https://github.com/RamaHerbin/squish/commit/29f5c2ac20a6a5d677b3b264d513cc5914a0a088))
* **share:** send a compressed file to the system share sheet ([#24](https://github.com/RamaHerbin/squish/issues/24)) ([6d0023c](https://github.com/RamaHerbin/squish/commit/6d0023cc5bda2b8f9b60d2321c8431f68654e0d0))
* **ui:** cursor-flair hover bloom on the home pill buttons ([#7](https://github.com/RamaHerbin/squish/issues/7)) ([6ca6e82](https://github.com/RamaHerbin/squish/commit/6ca6e82916ac90595be033fde0d4a7ee0a06e749))


### Fixed

* **ci:** npm ci lockfile validation on Linux runners ([#6](https://github.com/RamaHerbin/squish/issues/6)) ([2a85909](https://github.com/RamaHerbin/squish/commit/2a859099024bb5776a8b391c4649d0e37156e8c6))
* **codecs:** decode iPhone-screenshot HEICs correctly, via libheif 1.22.2 ([#25](https://github.com/RamaHerbin/squish/issues/25)) ([97b760d](https://github.com/RamaHerbin/squish/commit/97b760dc7ad5dbbce16aa90e231fabb65c1cbb7d))
* **editor:** remove the Auto-suggest pill ([#27](https://github.com/RamaHerbin/squish/issues/27)) ([268aab3](https://github.com/RamaHerbin/squish/commit/268aab31d349d29224be90f7b06914a4b811f76e))
* **pdf:** accept shared PDFs, and stop the Paste button lying about them ([#23](https://github.com/RamaHerbin/squish/issues/23)) ([f1c986e](https://github.com/RamaHerbin/squish/commit/f1c986e051aec5121199054595492bea1e215697))
* **pdf:** one Close, and compress without being asked ([#21](https://github.com/RamaHerbin/squish/issues/21)) ([b902085](https://github.com/RamaHerbin/squish/commit/b9020850e6aa83566742d940293f91a1c45e8e53))
* **pwa:** reload the page when the update toast's Reload is clicked ([#8](https://github.com/RamaHerbin/squish/issues/8)) ([89d3c15](https://github.com/RamaHerbin/squish/commit/89d3c15ce43f491242411d379a14665503853a51))
* repair COEP-less cached pthread workers killing threaded codecs ([#19](https://github.com/RamaHerbin/squish/issues/19)) ([50dfefa](https://github.com/RamaHerbin/squish/commit/50dfefa5d13a730d0dd22142b57ee83d12afd433))
* surface codec-worker failures and preserve wide-gamut display ([#12](https://github.com/RamaHerbin/squish/issues/12)) ([891b2b2](https://github.com/RamaHerbin/squish/commit/891b2b24e03f17d074046c95dcf704b354de8ea2))

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
