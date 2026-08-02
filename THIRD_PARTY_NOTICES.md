# Third-Party Notices

Pinch is MIT-licensed (see [LICENSE](./LICENSE)). It links against the
open-source components listed below, most of them WebAssembly builds of
native image codecs. This file records each component's license, upstream
source, and — where the license requires it — the attribution or source
notice that comes with it.

License texts are reproduced from the copy actually shipped in this
repository's `node_modules/<package>` at the time of writing (npm package
versions are pinned below); consult those files for the byte-exact text.

Jump to: [Runtime dependencies](#runtime-dependencies) ·
[HEIC/HEIF decoding (LGPL-3.0 component)](#heicheif-decoding-lgpl-30-component) ·
[Fonts](#fonts) · [Build/dev tooling](#builddev-tooling-not-shipped-to-users)

---

## Runtime dependencies

### @jsquash/\* (avif, jpeg, jxl, oxipng, png, qoi, resize, webp)

- **npm packages:** `@jsquash/avif@2.1.1`, `@jsquash/jpeg@1.6.0`,
  `@jsquash/jxl@1.3.0`, `@jsquash/oxipng@2.3.0`, `@jsquash/png@3.1.1`,
  `@jsquash/qoi@1.1.0`, `@jsquash/resize@2.1.1`, `@jsquash/webp@1.5.0`
- **Wrapper license:** Apache License 2.0 (each package's own `package.json`
  `license` field and `node_modules/@jsquash/<name>/LICENSE`)
- **Upstream:** <https://github.com/jamsinclair/jSquash>
- **What it is:** thin JS/TS wrappers that load the WebAssembly builds of the
  Squoosh app's codecs. Pinch imports these directly in
  `src/lib/codecs/codec.worker.ts` (encode/decode for AVIF, JPEG XL, WebP,
  MozJPEG, OxiPNG, QOI, and PNG decode) and for resizing
  (`src/lib/codecs/codec.worker.ts`, `@jsquash/resize`). The wasm binaries
  are used unmodified as published; nothing in this repository patches the
  codec sources.

Each wrapper bundles a wasm build of a specific upstream codec, under its own
upstream license, reproduced below with the file it was verified against.

#### mozjpeg (via `@jsquash/jpeg`)

- **License:** libjpeg-turbo's three-license set — the IJG (Independent JPEG
  Group) License, the Modified (3-clause) BSD License, and the zlib License
  — see `node_modules/@jsquash/jpeg/codec/LICENSE.codec.md` for the full,
  bundled text.
- **Upstream:** <https://github.com/mozilla/mozjpeg>
- **Notice required by the IJG license:** "This software is based in part on
  the work of the Independent JPEG Group."

#### libwebp (via `@jsquash/webp`, and PNG's shared codec base)

- **License:** BSD 3-Clause — `Copyright (c) 2010, Google Inc. All rights
  reserved.` See `node_modules/@jsquash/webp/codec/LICENSE.codec.md` (the
  same text also ships as `node_modules/@jsquash/png/codec/LICENSE.codec.md`,
  since `@jsquash/png`'s codec derives from the same Google-authored source).
- **Upstream:** <https://chromium.googlesource.com/webm/libwebp>

#### libavif + libaom (via `@jsquash/avif`)

- **libavif license:** BSD 2-Clause — `Copyright 2019 Joe Drago`. Upstream:
  <https://github.com/AOMediaCodec/libavif> (see `LICENSE` in that repo;
  `@jsquash/avif`'s `codec/enc/README.md` and `codec/dec/Readme.md` cite
  libavif v1.0.1 as the source).
- **libaom license:** BSD 2-Clause — `Copyright (c) 2016, Alliance for Open
  Media`. Upstream: <https://aomedia.googlesource.com/aom> (`LICENSE`).
- **libaom patent grant:** distributed alongside the BSD license is the
  **Alliance for Open Media Patent License 1.0**, a royalty-free patent
  grant covering conforming AV1 encoders/decoders (libaom is AVIF's AV1
  codec). Upstream: <https://aomedia.googlesource.com/aom> (`PATENTS`).
- Neither license file ships inside the `@jsquash/avif` npm package itself
  (only the top-level Apache-2.0 wrapper `LICENSE` does); the texts above
  were verified against the upstream repositories directly.

#### libjxl (via `@jsquash/jxl`)

- **License:** BSD 3-Clause. Upstream: <https://github.com/libjxl/libjxl>
  (`LICENSE`).
- As with libavif, no separate codec-license file ships inside the
  `@jsquash/jxl` npm package; the wrapper's own `README.md` names libjxl as
  the wrapped library, and the text above was verified against the upstream
  repository.

#### oxipng (via `@jsquash/oxipng`)

- **License:** MIT — `Copyright (c) 2016 Joshua Holmer`. See
  `node_modules/@jsquash/oxipng/codec/LICENSE.codec.md`.
- **Upstream:** <https://github.com/shssoichiro/oxipng>

#### qoi (via `@jsquash/qoi`)

- **License:** MIT — `Copyright (c) 2022 Dominic Szablewski`. See
  `node_modules/@jsquash/qoi/codec/LICENSE.codec.md`.
- **Upstream:** <https://github.com/phoboslab/qoi>

#### resize codecs (via `@jsquash/resize`)

`@jsquash/resize` bundles three interchangeable wasm resamplers; Pinch's
worker (`src/lib/codecs/codec.worker.ts`) uses whichever the caller selects
via `@jsquash/resize`'s public API.

- **squoosh-resize** — MIT, `Copyright (c) 2015 PistonDevelopers`. See
  `node_modules/@jsquash/resize/lib/resize/LICENSE.codec.md`.
- **hqx** — Apache License 2.0. See
  `node_modules/@jsquash/resize/lib/hqx/LICENSE.codec.md`.
- **magic-kernel** — MIT, `Copyright (c) 2024 Serhii Tatarintsev`. See
  `node_modules/@jsquash/resize/lib/magic-kernel/LICENSE.codec.md`.

---

### comlink

- **npm package:** `comlink@4.4.2`
- **License:** Apache License 2.0
- **Upstream:** <https://github.com/GoogleChromeLabs/comlink>
- **What it is:** RPC plumbing over `postMessage`, used to talk to the codec
  worker pool.

### fflate

- **npm package:** `fflate@0.8.3`
- **License:** MIT — `Copyright (c) 2026 Arjun Barrett` (as printed in
  `node_modules/fflate/LICENSE`)
- **Upstream:** <https://github.com/101arrowz/fflate>
- **What it is:** zip/deflate implementation used for batch export to ZIP.

### idb-keyval

- **npm package:** `idb-keyval@6.3.0`
- **License:** Apache License 2.0 — `Copyright 2016, Jake Archibald`
- **Upstream:** <https://github.com/jakearchibald/idb-keyval>
- **What it is:** small IndexedDB wrapper used for local persistence
  (presets, settings).

### pdfjs-dist (pdf.js)

- **npm package:** `pdfjs-dist@6.2.108`
- **License:** Apache License 2.0 — the package's `package.json` `license`
  field, with the full text at `node_modules/pdfjs-dist/LICENSE`.
- **Upstream:** <https://github.com/mozilla/pdf.js>
- **What it is:** Mozilla's PDF renderer. Pinch uses it to rasterise a page of
  the original and of the compressed PDF for the before/after reveal in the PDF
  view (`src/lib/pdf/render.ts`). It renders only — the structural rewriting is
  `@cantoo/pdf-lib`'s job, and pdf.js is never asked to write a PDF. The
  library and its worker are used unmodified as published.

pdf.js reaches for four data directories at runtime by URL rather than by
import. `vite.config.ts` (`pdfjsAssets`) copies three of them to
`/assets/pdfjs/<pdfjs-version>/` and deliberately leaves `standard_fonts/` out;
each carries its own upstream license, reproduced below with the file it was
verified against. The licenses ship next to the binaries in `dist/`, not only
here, since the BSD terms ask for the notice to accompany the binary form.

#### qcms (`wasm/qcms_bg.wasm`)

- **License:** MIT — `Copyright (C) 2009-2024 Mozilla Corporation` and
  `Copyright (C) 1998-2007 Marti Maria`. See
  `node_modules/pdfjs-dist/wasm/LICENSE_QCMS`.
- **Upstream:** <https://github.com/FirefoxGraphics/qcms> (Firefox's color
  management engine, descended from Marti Maria's Little CMS).
- **Binding license:** the wasm-bindgen glue Mozilla generates around it is
  BSD 2-Clause, `Copyright (c) 2025, Mozilla Foundation` —
  `node_modules/pdfjs-dist/wasm/LICENSE_PDFJS_QCMS`.
- **What it does here:** applies embedded ICC profiles when a PDF's images or
  color spaces carry one.

#### jbig2 (`wasm/jbig2.wasm`)

- **License:** BSD 3-Clause — `Copyright 2014 The PDFium Authors`, with the
  "neither the name of Google Inc. nor the names of its contributors" clause.
  See the first 27 lines of `node_modules/pdfjs-dist/wasm/LICENSE_JBIG2`; the
  remainder of that same file is the Apache-2.0 text covering PDFium's own
  later contributions.
- **Upstream:** <https://pdfium.googlesource.com/pdfium> (the JBIG2 and CCITT
  fax decoders, compiled to wasm by pdf.js).
- **Binding license:** Apache License 2.0, `Copyright 2026 Mozilla Foundation`
  — `node_modules/pdfjs-dist/wasm/LICENSE_PDFJS_JBIG2`.
- **What it does here:** decodes JBIG2 and CCITT G3/G4 images, the two
  compression schemes scanned black-and-white pages arrive in.

#### openjpeg (`wasm/openjpeg.wasm`)

- **License:** BSD 2-Clause — `Copyright (c) 2002-2014, Universite catholique
  de Louvain (UCL), Belgium`, Professor Benoit Macq, Antonin Descampe,
  Francois-Olivier Devaux, Herve Drolon (FreeImage Team), Yannick Verschueren,
  David Janssens, CNES and CS Systemes d'Information. See
  `node_modules/pdfjs-dist/wasm/LICENSE_OPENJPEG`.
- **Patent notice required by that file:** "This software may be subject to
  other third party and contributor rights, including patent rights, and no
  such rights are granted under this license." JPEG 2000's core coding is long
  out of patent, but the disclaimer is part of the license text and is
  reproduced here because the license reproduces it.
- **Upstream:** <https://github.com/uclouvain/openjpeg>
- **Binding license:** BSD 2-Clause, `Copyright (c) 2024, Mozilla Foundation`
  — `node_modules/pdfjs-dist/wasm/LICENSE_PDFJS_OPENJPEG`.
- **What it does here:** decodes JPEG 2000 (`JPXDecode`) images, which is how
  most print-origin and archival PDFs store photographs.

#### Adobe CMap resources (`cmaps/*.bcmap`)

- **License:** BSD 3-Clause — `Copyright 1990-2009 Adobe Systems Incorporated.
  All rights reserved.` The text ships as `%%Copyright:`-prefixed PostScript
  comments at `node_modules/pdfjs-dist/cmaps/LICENSE`, which is copied into
  `dist/` alongside the maps.
- **Upstream:** <https://github.com/adobe-type-tools/cmap-resources>
- **What it does here:** the 168 predefined CJK character maps. Without the one
  a document names, text in that encoding does not render at all, so a preview
  of a Japanese or Chinese PDF would come back blank rather than merely
  substituted.

#### CGATS001Compat ICC profile (`iccs/CGATS001Compat-v2-micro.icc`)

- **License:** CC0 1.0 Universal (public domain dedication) — full text at
  `node_modules/pdfjs-dist/iccs/LICENSE`.
- **Upstream:** shipped by pdf.js as the default CMYK profile
  (<https://github.com/mozilla/pdf.js>, `external/iccs`).
- **What it does here:** the fallback profile for `DeviceN`/CMYK color spaces
  that name no profile of their own.

---

## HEIC/HEIF decoding (LGPL-3.0 component)

Pinch decodes HEIC/HEIF input (iPhone photos) through **heic-to**, which
bundles a **libheif** build compiled all the way to JavaScript. This is the
one runtime dependency under a copyleft license, so it gets its own
paragraph.

- **heic-to** — npm `heic-to@1.5.2`, license **LGPL-3.0**, per
  `node_modules/heic-to/package.json` and the full GNU LGPLv3 text at
  `node_modules/heic-to/LICENSE`, which opens with the project's own grant:
  "heic-to is free software: you can redistribute it and/or modify it under
  the terms of the GNU Lesser General Public License as published by the
  Free Software Foundation, either version 3 of the License, or (at your
  option) any later version." Author: Hopper Gee. Upstream:
  <https://github.com/hoppergee/heic-to>. Note the difference from every
  codec above: the wrapper is not a permissive shell around a copyleft core,
  it is LGPL itself, so the whole imported chunk is LGPL-3.0.
- **libheif** — the codec, Emscripten-compiled and shipped inside that same
  package as `src/lib/libheif.js`, whose first line records the build:
  `// Build from libheif 1.22.2 with LIBDE265_VERSION=1.0.16`. License:
  **LGPL-3.0**. Upstream: <https://github.com/strukturag/libheif>. libheif's
  own upstream license note reads: "The library `libheif` is distributed
  under the terms of the GNU Lesser General Public License. The sample
  applications and the Go and C++ wrappers are distributed under the terms
  of the MIT License."
- **libde265** 1.0.16, the HEVC decoder libheif calls into for HEIC frame
  decoding, is compiled into that same file rather than loaded beside it
  (the built module exports `de265_get_version`). libde265 is licensed under
  **LGPL-3.0** by its upstream project:
  <https://github.com/strukturag/libde265>.

Unlike the `@jsquash/*` codecs, nothing here is a `.wasm` binary: heic-to
ships Emscripten's `wasm2js` output, so libheif arrives as ~3 MB of ordinary
JavaScript with no separate wasm file to fetch. That changes the payload's
size and its speed, not its licensing.

**How Pinch uses it, and why this satisfies LGPL-3.0:**

- Pinch imports `heic-to` unmodified, as published on npm — no file in the
  package has been forked, patched, or recompiled for this project, and the
  libheif/libde265 build it carries is the one its author published. See
  `src/lib/codecs/codec.worker.ts` (`const loadHeicDecoder = () =>
  loadOnce('dec:heic', () => import('heic-to'))`) — it is a dynamic
  `import()`, loaded only when a HEIC/HEIF file is actually opened on a
  browser with no native HEIC decoder, inside a Web Worker.
- LGPL-3.0 §4 permits combining an unmodified LGPL library with an
  application under any license, provided the LGPL component can be swapped
  out and its corresponding source is available. Both hold here: the build is
  dynamically loaded as a discrete, replaceable chunk — Rollup emits it as
  its own `heic-to-*.js` file, which `vite.config.ts` names in `globIgnores`
  and `src/lib/shell/sw.ts` routes by that prefix, so the boundary is
  addressable rather than buried in Pinch's own bundle — and full
  corresponding source is public upstream: libheif and libde265 at the
  repositories linked above, heic-to's own wrapper source at
  <https://github.com/hoppergee/heic-to>, and, in that repository's README,
  the procedure used to regenerate the shipped `libheif.js` (libheif's own
  `build-emscripten.sh` run with `USE_WASM=0`, which is what makes the
  output JavaScript rather than wasm).
- Pinch itself adds no HEIC/HEIF *encoding* — decode-only, deliberately
  (`src/lib/codecs/codec.worker.ts`: "libheif 1.22.x (via heic-to) — decode
  only; HEIC encoding is patent-encumbered").

---

## Fonts

### Archivo (@fontsource/archivo) and Space Mono (@fontsource/space-mono)

- **npm packages:** `@fontsource/archivo@5.3.0`, `@fontsource/space-mono@5.3.0`
- **Package license:** OFL-1.1 (per each package's `package.json`)
- **Font license:** SIL Open Font License, Version 1.1
- **Font copyright:**
  - Archivo — Copyright 2020 The Archivo Project Authors
    (<https://github.com/Omnibus-Type/Archivo>)
  - Space Mono — Copyright 2016 The Space Mono Project Authors
    (<https://github.com/googlefonts/spacemono>)
- Full OFL-1.1 text ships at `node_modules/@fontsource/archivo/LICENSE` and
  `node_modules/@fontsource/space-mono/LICENSE`; `@fontsource` repackages the
  same Google Fonts files distributed at <https://fontsource.org>. OFL fonts
  may be used, embedded, and redistributed freely as part of an application
  (they just can't be resold on their own), which is how Pinch uses them —
  bundled as local `@font-face` assets, no remote Google Fonts requests.

---

## Build/dev tooling (not shipped to users)

The following are development-time dependencies only — compiled away by the
Vite build and never present in the shipped app bundle. Listed for
completeness, not because they impose runtime obligations.

| Package | Version | License |
|---|---|---|
| svelte | 5.56.7 | MIT |
| vite | 8.1.5 | MIT |
| vitest | 4.1.10 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| vite-plugin-pwa | 1.3.0 | MIT |
| @sveltejs/vite-plugin-svelte | 7.2.0 | MIT |

A full scan of every `package.json` under `node_modules` (431 packages at
time of writing, dev and runtime combined) found one `LGPL-3.0` package
(`heic-to`, covered above) and two files under weak-copyleft or
attribution licenses, both build-time-only and neither shipped in the app
bundle:

- `lightningcss` / `lightningcss-darwin-arm64` — **MPL-2.0**, pulled in by
  Vite's CSS pipeline. MPL-2.0 is file-level copyleft: it applies to
  modifications of lightningcss's own source, not to code that merely runs
  it as a build tool. Pinch does not vendor or modify it.
- `caniuse-lite` — **CC-BY-4.0** (browser support data, not code), pulled in
  transitively for build tooling. Attribution: caniuse.com / Can I Use
  project. Not present in the shipped bundle.
- `@napi-rs/canvas` — **MIT**, `@napi-rs/canvas@1.0.3`. An *optional*
  dependency of `pdfjs-dist`, so npm installs it (26 MB of prebuilt native
  binaries) even though nothing here can reach it: it is how pdf.js gets a
  canvas under Node, and `pdfjs-dist`'s `package.json` `browser` field maps
  `canvas` to `false` for every bundler. Listed because its size makes an
  auditor look twice, not because it ships.

Every other package resolved to `MIT`, `Apache-2.0`, `ISC`, `BSD-2-Clause`,
`BSD-3-Clause`, `BlueOak-1.0.0`, `MIT-0`, `CC0-1.0`, or `OFL-1.1` — all
permissive. See `package-lock.json` for the full resolved tree if you need
to audit a specific transitive package.
