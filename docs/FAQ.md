# FAQ

## Where do my images go?

Nowhere. Every decode, encode and measurement happens in your browser — in a Web Worker
on your machine, using codecs compiled to WebAssembly. There is no server to upload to,
no account, and no analytics.

You can check this the direct way: open your browser's network panel, compress something,
and watch. The only requests are for the app's own code and the codec `.wasm` chunks,
each fetched once and then cached. Opening a PDF adds one more set of the same kind: the
pdf.js renderer, its worker and its data files, all served from this origin and cached
after the first document. Nothing goes out. Or turn the network off entirely — Pinch is a PWA
that precaches its shell and runtime-caches codecs, so after one visit it works offline.
Nothing to upload also means nothing to leak.

Batch results are staged to the [Origin Private File System](https://developer.mozilla.org/docs/Web/API/File_System_API/Origin_private_file_system)
so a large run does not fill memory. That is private to the origin, on your disk, and
Pinch deletes its own session directory when the queue is cleared (plus sweeps sessions
older than 12 hours on startup, in case a tab crashed).

## Why can't I *encode* to HEIC?

Two reasons, and the second is the one that actually decides it.

1. **Patents.** HEIC is HEVC (H.265) in an ISO-BMFF container, and HEVC is covered by
   several patent pools. Shipping an encoder in a free web app is not a fight worth
   picking.
2. **There is no maintained WebAssembly HEVC encoder to ship.** Even setting licensing
   aside, there is nothing to build against that could be depended on.

Decoding is a different matter and is fully supported: Safari decodes HEIC natively, and
everywhere else Pinch falls back to a bundled build of libheif 1.22.x (the `heic-to`
package). So iPhone photos open fine — you just convert them to AVIF, JPEG XL, WebP or
JPEG on the way out, which is usually what you wanted anyway.

## Why can't I encode HDR?

The pipeline is 8-bit sRGB `ImageData` end to end. Every step — rotate, crop, resize,
SSIM — operates on those pixels, and the encoders are fed the same buffer.

HDR sources are still handled properly on the way in. Pinch scans the file header for
the CICP transfer characteristic in AVIF/HEIC/HEIF (16 = PQ, 18 = HLG) and for gain-map
markers (Ultra HDR JPEG, Apple HEIC), then labels the source `HDR (PQ)`, `HDR (HLG)` or
`HDR (gain map)` in the UI. The pixels themselves are tone-mapped to SDR by whichever
decoder ran. The output is honest SDR, and the interface says so instead of implying
your highlights survived.

The fourth sample on the home screen, `demo-hdr.avif`, is a real 10-bit PQ file (BT.2020
primaries, a 950-nit highlight) if you want to see that path without digging a photo out
of your phone.

Proper HDR output would mean a 10-bit-or-higher pipeline, a colour-management story for
the preview canvas, and gain-map muxing on export. That is a different application, not
a flag.

## Why is there no palette / colour quantization?

Squoosh has one (reduce to N colours, with dithering) and it is genuinely useful for flat
graphics and screenshots. Pinch does not, for a licensing reason rather than a technical
one: the standard implementation is **libimagequant**, which is GPL-3.0-or-later.
Linking it into an MIT-licensed app would require relicensing the whole app under the
GPL.

The Palette switch in the editor toolbar is a disabled placeholder, marked "coming
soon", rather than a control that quietly does nothing. If a permissively-licensed
quantizer shows up — or if a wasm build can be isolated behind a boundary that satisfies
the licence — it goes in.

In the meantime, OxiPNG at a higher effort level does most of the work for flat
graphics, and WebP lossless is usually smaller still.

## What happens to my EXIF metadata?

It is stripped.

Every encoder here re-encodes pixels and writes a fresh container. Nothing carries
metadata across, so camera model, lens, timestamps, GPS coordinates and copyright tags
do not survive a compression pass. For most people publishing images to the web this is
a feature — location data in a photo you post is a real privacy problem — but it is worth
knowing before you compress your only copy.

There is a **Keep EXIF metadata** toggle in Settings → Defaults. It persists your
preference and nothing more: v1 always re-encodes pixels, and metadata pass-through has
not been implemented. The settings screen says this out loud under the toggle rather than
leaving you to discover it. If you need the metadata, keep the original file — Pinch
never modifies it.

The one exception is the pass-through side of the compare view: `identity` hands back
the original bytes untouched, so downloading from that side gives you the file exactly
as it was.

## Why SSIM and not butteraugli?

Butteraugli is the better metric. It models the human visual system properly, and it is
what you should use if you are tuning an encoder.

Pinch uses SSIM because of where the number is needed:

- on **every slider commit**, so the verdict updates as you drag;
- on **every one of the 20 matrix cells**.

At that call rate the cost has to be a few tens of milliseconds, not a few hundred, and
it has to run without another multi-megabyte wasm module in the critical path. The
implementation here is single-scale SSIM on the Rec.709 luma plane, 8×8 non-overlapping
windows, with images box-averaged down to a 2 MP budget first — pure arithmetic in a
worker, no codec involved.

The properties the UI actually depends on are: it returns exactly 1 for identical
inputs, it is monotone in quality (a verdict never gets worse as you raise the slider),
and it is stable enough that the same image scores the same twice. SSIM delivers those.
The extra fidelity of butteraugli would not change a single decision the interface
offers you.

`MetricsResult` has an optional `butteraugli` field for the day that trade-off changes.
Nothing populates it today, and `undefined` means "not measured", not "identical".

## Why does my SSIM say `—` / `Unmeasured`?

SSIM is undefined across different pixel grids: with resize enabled there is no
correspondence between an input pixel and an output pixel. Rather than comparing a
downscaled output against the full-size original and reporting a meaningless number,
Pinch reports `null` and the verdict reads `Unmeasured`. Turn resize off to get a score
back.

The same applies to matrix cells whose format cannot be decoded back to pixels for the
comparison — the size figure is still perfectly good, only the metric is missing.

## Why is my "compressed" file bigger than the original?

Usually one of:

- **The source was already compressed with the same or a better codec.** Re-encoding a
  well-tuned JPEG at q90 will often grow it. The savings column shows a negative number
  when this happens, and the matrix prefers cells that save at least 5% when any of them
  do.
- **A lossless format over a lossy source.** OxiPNG or QOI applied to a photograph
  produces a much larger file than the JPEG you started from. Both are for graphics and
  screenshots.
- **Quality set very high.** Above roughly q95 every codec spends bytes on detail nobody
  can see.

The Original side of the compare is always available for download unchanged, so a bad
trade costs you nothing.

## What does Pinch actually do to a PDF?

It rewrites the raster images inside it, and nothing else. Pinch opens the document,
finds every embedded image, re-encodes the ones it can safely decode as JPEG at the
quality you picked — optionally downsampling anything drawn above a target DPI — and
writes the file back with those image streams swapped.

Text, vectors, fonts, page structure, the page count and the accessibility tree are
untouched. That is the whole design: a PDF is never decoded and rebuilt, it is edited in
place. It also means the honest unit of work is the *image*, not the document, which is
why the screen gives you a row per embedded image instead of one "42% smaller" and no
explanation of where the other 58% went.

Two settings beyond quality and DPI are on by default and are pure structural wins:
**dedupe identical images** points byte-identical streams at a single object, and **strip
metadata** drops the XMP metadata stream and page thumbnails. Neither touches a pixel.

## Why did my PDF barely shrink?

Because there was not much image in it. A text-and-vector document — an invoice, a
contract, a LaTeX paper — is mostly content Pinch deliberately does not rewrite, so
there is nothing to win. If the document has no embedded images at all, the table says
so, and stripping metadata is the only saving on offer.

The other common case is a document whose images Pinch will not touch. Every skipped
image says why in its own row:

- **Too small** — under 4 KB. A decode plus an encode costs more than it could save.
- **No decoder** — JPEG 2000, JBIG2, CCITT fax, LZW, RunLength, or a chained filter.
  Pinch ships decoders for `DCTDecode` and `FlateDecode` and refuses to guess at the
  rest. Also shown for Flate images when you switch **Flate → JPEG** off, which removes
  the only decoder path left.
- **CMYK** — print colour. Adobe writes these inverted behind an APP14 marker, and
  getting that wrong yields a colour negative rather than a slightly soft image.
- **Colour space** — an exotic colour space, non-8-bit samples, or a non-identity
  `/Decode` array such as the inverted-grayscale scans some scanners emit.
- **Mask** — a stencil or colour-key mask. A shape, not a picture.
- **No gain** — it was recompressed, the result was not smaller, so the original was
  kept. This one can only appear after a run, never in the plan.
- **Failed** — the decode or encode threw. The original stayed.

The first five are computed before anything is decoded, so the plan column tells you
what will happen while you are still moving the quality slider.

## Why won't it open my encrypted or signed PDF?

Because the honest answers are "I can't" and "I shouldn't".

An **encrypted** PDF cannot be read without the password, and rewriting a file Pinch
cannot decrypt produces a broken one. Remove the password first.

A **digitally signed** PDF is refused on purpose. Any rewrite invalidates the signature —
that is what a signature is for. Pinch could strip the images and hand you back a
document whose signature no longer verifies, which is worse than doing nothing, so it
declines and says why.

An **unreadable** file is one pdf-lib could not parse at all: not a PDF, or damaged.

In all three cases you get a sentence and a way out, never a cheerful "0% saved" over a
file that was never touched.

## Will the pages still look right?

That is a question about pixels, and bytes cannot answer it — so the PDF screen renders
the pages. After a run you get the original page and the compressed one under the same
draggable divider the image editor uses, at one shared scale, and you can page through
the document.

Worth knowing what you are looking at: only image pixels changed, so most of a rendered
page is identical on both sides and is there as context. The divider is for the
photographs.

One caveat the preview will show you: transparency in an embedded image is flattened.
Baseline JPEG carries no alpha channel, so a soft mask is folded in and dropped on
replace.

## What is the relationship to Squoosh?

Squoosh is the reason Pinch exists. It proved the whole idea — codecs in WebAssembly,
running client-side, with a real comparison view.

What is shared:

- **The codec builds.** Both use [jSquash](https://github.com/jamsinclair/jSquash), the
  community-maintained npm packaging of the same Squoosh wasm codecs (Apache-2.0).
- **A handful of techniques, ported and re-derived in TypeScript**, each marked in the
  header of the file that carries it:
  - `src/lib/compare/pinch-zoom.ts` — the pan/zoom engine, ported from Squoosh's
    `<pinch-zoom>` custom element. Two deliberate differences: raw pointer events
    tracked in a `Map` instead of `pointer-tracker` and `setPointerCapture` (whose event
    retargeting broke on iOS Safari), and closed-form transform maths instead of
    `DOMMatrix` (fewer allocations per `pointermove`, and testable under jsdom, which
    ships no `DOMMatrix`).
  - `src/lib/codecs/bridge.ts` — the worker bridge, ported from Squoosh's
    `client/lazy-app/worker-bridge`: lazy spawn, idle terminate, serialised calls, and
    abort-equals-terminate.
  - `src/lib/state/result-cache.ts` — the five-entry LRU that makes quality scrubbing
    instant. Depth 5 is Squoosh's number.
  - `src/lib/contracts/image.ts` — the magic-number sniffing table.
  - `src/lib/shell/sw.ts` — the two-tier cache split (shell precache vs runtime-cached
    codecs) modelled on Squoosh's `to-cache.ts`.
  - `src/lib/options/knobs.ts` — deriving a "lossless" switch from the shape of the real
    encoder options, the way Squoosh does, so the checkbox and the slider always agree.

Everything else is new: the job engine and its work diffing, the reveal compare surface,
SSIM and verdicts, the codec matrix, the batch queue with OPFS staging and ZIP export,
tabs, presets and preset sharing, HEIC input, HDR detection, crop, and the entire design
system. No Squoosh source tree is vendored, and the stack is different (Svelte 5 runes
and Vite 8 rather than Preact and Webpack).

Squoosh still does things Pinch does not — palette quantization with dithering, an
experimental WebP v2 encoder, translations, and a track record measured in years. The
comparison table in the [README](../README.md#pinch-vs-squoosh) is meant to be read in
both directions.

## Is there a CLI, or an API I can call?

No. Pinch is a browser application. There is no CLI, no server API, and no headless
mode. If you want to script image compression, use the underlying libraries directly —
`@jsquash/*` in Node, or `sharp` / `libvips` if you do not need the exact same encoders.

## Can I use it offline?

Yes, once you have loaded it once. The app shell is precached by the service worker;
each codec's wasm is cached the first time you use that codec. The pdf.js renderer behind
the PDF preview works the same way — it is deliberately kept out of the precached shell,
because a visitor who never opens a PDF should not pay to download it, and it is cached
from the first document onward. Install it (Chromium's
install button, or Add to Home Screen on iOS) and it behaves like a local application.

A new version installs in the background and waits — you get a "Reload" prompt rather
than a silent swap under a half-finished encode.

## What are the limits?

- **50 MB per image, 150 MB per PDF.** Larger files are skipped and named in the
  message. PDFs get the higher ceiling because the work is sequential and streamed —
  the real limit is peak memory during one image's decode, not the file's size.
- **4 KB per embedded image** before a PDF image is worth recompressing at all.
- **5000 files per drop**, and 16 levels of directory recursion, so a stray
  `node_modules` cannot hang the tab.
- **8 parallel worker lanes** for batch and matrix runs, or
  `hardwareConcurrency - 2` — whichever is smaller. Two cores are left for the
  compositor and the main thread so the page keeps responding.
- **~2 KB for a shared preset link.** Presets are settings only, so real ones are far
  under that.

Beyond those, the ceiling is your device's memory: a decoded image costs
width × height × 4 bytes, and several of those exist at once during an encode.

## Something went wrong — how do I report it?

Open an issue at <https://github.com/RamaHerbin/squish/issues>. What helps most: the
browser and version, the input format and roughly its dimensions, the encoder and
settings you picked, and whether it reproduces with a different file. Please do not
attach anything private — remember that Pinch never sees your images, so the maintainers
have not either.
