# e2e HEIC fixtures

Hand-generated binaries (like `public/demo/demo-vector.svg`, these are source,
not `generate-assets.mjs` output — the tools below are macOS-only and the
script's byte-determinism contract doesn't hold for them).

## The pattern

Both synthetic fixtures rasterise the same 1320×900 test card, built so that
decoder corruption is a number, not an impression:

- **Neutral column**: `|x − 660| < 100` is pure grey (R=G=B), a vertical
  luminance ramp. Any channel spread there is chroma corruption.
- **Hue quadrants** around it: top-left red, top-right green, bottom-left
  blue, bottom-right yellow, each ramping with x. Grid tiles assembled in the
  wrong place put the wrong hue under a probe point.
- 1320 is deliberately not a multiple of 512, so the HEIF grid has partial
  edge tiles, like an iPhone capture.

`e2e/heic.smoke.spec.ts` asserts exact dimensions, neutral-column spread ≤ 6,
and quadrant dominance at four probe points.

## Recipes

Pattern PNG (16-bit RGB): the deterministic generator lives in the spec's
comments' companion below; any equivalent 1320×900 render of the geometry
above works.

`heic-10bit-420-apple.heic` — Apple CoreImage encoder, 10-bit 4:2:0, 3×2 grid
of 512px tiles, Display P3. macOS 26 (Darwin 25.5), Swift 6:

```swift
import CoreImage
let img = CIImage(contentsOf: URL(fileURLWithPath: "pattern16.png"))!
try! CIContext().writeHEIF10Representation(of: img,
  to: URL(fileURLWithPath: "heic-10bit-420-apple.heic"),
  colorSpace: CGColorSpace(name: CGColorSpace.displayP3)!,
  options: [CIImageRepresentationOption(rawValue:
    kCGImageDestinationLossyCompressionQuality as String): 0.85])
```

`heic-10bit-444-icc.heic` — libheif 1.22.2 `heif-enc` (x265 4.2), 10-bit
4:4:4, 3×2 grid, ICC `prof` (no nclx), the closest synthesisable structural
match to an iPhone screenshot:

```sh
heif-enc -b 10 --cut-tiles 512 -q 90 -p chroma=444 pattern16.png -o out.heic
```

## What these do and don't guard

Both fixtures decode **cleanly on the broken decoder too** (`libheif-js`
1.19.8, replaced by `heic-to` in the commit that added this directory). The
corruption that motivated the swap triggers only on **Apple's own encoder at
10-bit 4:4:4** — the iPhone *screenshot* format — and four synthetic
look-alikes (x265 4:4:4, CoreImage 4:2:0, GBR-matrix, ICC-only) all failed to
reproduce it. So these fixtures are a smoke net for the decode pipeline and
the chunk-name coupling, not a regression test for that exact bitstream.

## The gold fixture (`heic-10bit-444-apple-screenshot.heic`, optional)

The one rights-clean way to capture the triggering bitstream: open
`gold-pattern.html` full screen on an iPhone, take a screenshot (iOS writes
10-bit 4:4:4 HEIC through Apple's encoder), and commit it under that name —
the skipped test in `heic.smoke.spec.ts` picks it up automatically, sampling
relative coordinates that avoid the status bar. Before committing, verify the
candidate actually reproduces on the old decoder
(`npx -y heic-decode` is not a CLI; quickest is a scratch Node script against
`heic-decode@2.1.0` asserting the neutral column) — a non-triggering variant
belongs in the bin, not the repo.
