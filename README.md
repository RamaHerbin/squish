# Pinch

Client-side image compression in your browser. Nothing is uploaded — every codec
runs locally in WebAssembly, and the app works offline.

Pinch is a spiritual successor to [Squoosh](https://github.com/GoogleChromeLabs/squoosh)
(no longer maintained), rebuilt on a 2026 stack with the features Squoosh never got.

## Features

- **Reveal compare** — one canvas, a draggable divider wiping between the
  original and the encoded output, under a single shared pan/zoom.
- **Encoders** — AVIF, JPEG XL, WebP, MozJPEG, OxiPNG, QOI via
  [jSquash](https://github.com/jamsinclair/jSquash), plus the browser's native
  PNG/JPEG/WebP encoders.
- **Decoders** — native browser decoding first (WebCodecs `ImageDecoder`),
  WASM fallback for AVIF/JXL/WebP/QOI — and **HEIC/HEIF** input via libheif.
- **HDR-aware input** — PQ/HLG (AVIF, HEIC) and gain-map HDR (Ultra HDR JPEG,
  Apple HEIC) are detected and labelled; pixels are tone-mapped to SDR for
  encoding, and the UI says so instead of pretending otherwise.
- **SSIM metrics** — a real SSIM score for every encode, with plain-language
  verdicts, computed in a worker.
- **Auto-suggest** — binary-searches the smallest quality that still looks
  identical (SSIM ≥ threshold).
- **Codec matrix** — every lossy encoder × four quality steps, sizes, SSIM and
  a recommended cell, in one table.
- **Batch queue** — drop folders, process N files in parallel through a worker
  pool, export a ZIP.
- **Shareable presets** — settings serialized into a URL fragment
  (CompressionStream + base64url) or a `.json` file.
- **Light editing** — rotate and crop before compressing.
- **PWA** — installable, offline, OS share target and file handler.

## Stack

Vite + Svelte 5 (runes) + TypeScript strict. Codecs run in a Web Worker behind
Comlink; cancellation is `worker.terminate()`. COOP/COEP headers enable
threaded WASM. Design system: "Pinch — Editorial" (cream paper, 1.5px ink,
Archivo + Space Mono, self-hosted).

## Develop

```sh
npm install
npm run dev        # dev server with COOP/COEP
npm run build      # production build + service worker
npm run preview    # serve the build
npm run check      # svelte-check (strict)
npm test           # vitest
```

## Privacy

Images never leave your device. There is no server, no analytics, no account.
