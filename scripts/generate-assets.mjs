#!/usr/bin/env node
/**
 * Pinch — visual asset generator.
 *
 * Rebuilds every binary asset the app ships from source that lives in this
 * repo: the PWA icons (from `public/icons/*.svg`), the favicon, the Open
 * Graph card, the two bundled demo rasters, and the documentation
 * screenshots. Nothing here reaches the network — fonts are read from the
 * installed `@fontsource` packages and inlined as `data:` URIs, and the demo
 * photos are synthesised with `<canvas>`.
 *
 * Rendering is done by the same headless Chrome the project already uses for
 * browser tests (`playwright-core`, a devDependency). Chrome itself is *not*
 * bundled: set `CHROME_PATH` if yours is not in one of the usual locations.
 *
 *   node scripts/generate-assets.mjs              # everything
 *   node scripts/generate-assets.mjs icons og     # a subset
 *
 * Targets: `icons` (+ favicon), `macos` (the Tauri app icon), `og`, `demo`,
 * `pdf`, `hdr`, `shots`. `shots` boots `vite` on a free port and drives the
 * real app, so it is the slow one; the rest are pure rendering and take a
 * couple of seconds.
 *
 * `macos` and `hdr` are opt-in and excluded from a bare, argument-less run:
 * they shell out to `iconutil` (macOS only) and `avifenc` (libavif, not an npm
 * dependency), so they must be named explicitly rather than breaking the
 * default "everything" run for a contributor who has just cloned and run
 * `npm install`. `pdf` needs neither — `@cantoo/pdf-lib` is already a runtime
 * dependency — so it is part of the default run.
 *
 * Outputs (all overwritten in place, all committed):
 *   public/icons/icon-192.png          192×192   from icon.svg
 *   public/icons/icon-512.png          512×512   from icon.svg
 *   public/icons/icon-maskable-512.png 512×512   from icon-maskable.svg
 *   public/favicon.ico                 32×32     PNG-in-ICO container
 *   src-tauri/icons/icon.icns          7 sizes   from icon.svg, via iconutil
 *   src-tauri/icons/icon.png           512×512   from icon.svg
 *   src-tauri/icons/32x32.png          32×32     from icon.svg
 *   src-tauri/icons/128x128.png        128×128   from icon.svg
 *   src-tauri/icons/128x128@2x.png     256×256   from icon.svg
 *   public/og.png                      1200×630  social card
 *   public/demo/demo-gradient.jpg      1600×1200 duotone gradient, JPEG q0.86
 *   public/demo/demo-poster.png        1200×900  geometric poster, PNG
 *   public/demo/demo-report.pdf        2 pages   demo-gradient.jpg + demo-poster.png, oversized
 *   public/demo/demo-hdr.avif          1600×1200 the same sheet, 10-bit PQ
 *   docs/media/home.png                1440×1010 app screenshot
 *   docs/media/editor.png              1440×900  app screenshot
 *   docs/media/pdf.png                 1440×1100 app screenshot
 */

import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';
import { PDFDocument, PageSizes, StandardFonts } from '@cantoo/pdf-lib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const p = (...segments) => path.join(ROOT, ...segments);

/** Brand tokens, mirrored from `src/app.css` (`:root`). Keep in sync. */
const INK = '#141414';
const PAPER = '#FBF7EB';
const SURFACE = '#FFFCF2';
const CREAM = '#F4EEE0';
const BLUE = '#1B6EF3';
const YELLOW = '#F5B40C';
const GREEN = '#12A147';
const RED = '#E5372B';
const PURPLE = '#8E55E9';

/** Encoder labels, mirrored from `ENCODER_REGISTRY` in src/lib/codecs/registry.ts. */
const WASM_ENCODER_LABELS = ['AVIF', 'JPEG XL', 'WEBP', 'MOZJPEG', 'OXIPNG', 'QOI'];

/**
 * The chassis the three bundled samples share, in fractions of the canvas so
 * one set of numbers covers every size: paper ground, ink frame, flat accent
 * shapes outlined in ink, a block of hairlines, an Archivo display word and a
 * Space Mono caption. `public/demo/demo-vector.svg` is hand-authored
 * against the same fractions on its own 640×480 box — keep the two in step.
 *
 * `inset` and `frame` are fractions of the width; the rest of the height.
 */
const POSTER = {
  inset: 0.0283,
  frame: 0.005,
  hairline: 0.0017,
  display: 0.085,
  caption: 0.024,
};

/**
 * Geometry of the gradient sample, in pixels, from one set of fractions.
 *
 * Shared on purpose: `paintGradient` draws from it and `buildHdr` reads the
 * two light sources back out of it to decide which pixels are emissive. If the
 * sun moved in the painter but not in the HDR pass, the AVIF would carry a
 * 900-nit disc somewhere the artwork has none.
 */
function gradientGeometry(w, h, P) {
  const inset = Math.round(w * P.inset);
  const fx = Math.round(w * 0.4);
  const fy = Math.round(h * 0.12);
  return {
    inset,
    frame: Math.round(w * P.frame),
    fx,
    fy,
    fw: w - inset - fx,
    fh: h - inset - fy,
    /** The yellow quarter-disc, read as the sun by the HDR pass. */
    sun: { x: inset, y: inset, r: Math.round(h * 0.28) },
    /** The cream disc straddling the field's left edge, read as the moon. */
    moon: { x: fx, y: Math.round(h * 0.42), r: Math.round(h * 0.155) },
  };
}

/**
 * A canvas draw silently falls back to a system font unless the face is
 * actually loaded: declaring `@font-face` is not enough, and
 * `document.fonts.ready` has nothing to wait for on a page whose DOM never
 * uses the family. Every canvas painter therefore asks for its faces by hand
 * before the first `fillText`.
 */
const POSTER_FACES = ["700 100px 'Archivo'", "400 100px 'Space Mono'"];

/* -------------------------------------------------------------------------- */
/* Plumbing                                                                    */
/* -------------------------------------------------------------------------- */

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function chromeExecutable() {
  const found = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (found) return found;
  throw new Error(
    `No Chrome/Chromium found. Set CHROME_PATH to your browser binary. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}`,
  );
}

/** Both font families, inlined as base64 `@font-face` rules — no network. */
async function fontFaceCss() {
  const faces = [
    ['Archivo', 400, '@fontsource/archivo/files/archivo-latin-400-normal.woff2'],
    ['Archivo', 700, '@fontsource/archivo/files/archivo-latin-700-normal.woff2'],
    ['Archivo', 900, '@fontsource/archivo/files/archivo-latin-900-normal.woff2'],
    ['Space Mono', 400, '@fontsource/space-mono/files/space-mono-latin-400-normal.woff2'],
    ['Space Mono', 700, '@fontsource/space-mono/files/space-mono-latin-700-normal.woff2'],
  ];
  const rules = await Promise.all(
    faces.map(async ([family, weight, relative]) => {
      const file = p('node_modules', relative);
      const base64 = (await fs.readFile(file)).toString('base64');
      return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${base64}) format('woff2');}`;
    }),
  );
  return rules.join('\n');
}

/** `page.setContent` + wait for the inlined webfonts to be ready to paint. */
async function loadPage(browser, { width, height, deviceScaleFactor = 1, html }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/** Write a base64 `data:` URL payload to disk and report what landed. */
async function writeDataUrl(file, dataUrl) {
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  return bytes;
}

/** Read a PNG's IHDR so the summary reports measured, not intended, sizes. */
function pngSize(bytes) {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * Read an AVIF's `ispe` box, for the same reason. Bounded scan rather than a
 * container walk: `ispe` is `version(1) flags(3) width(4) height(4)`, and the
 * first one in the file belongs to the primary item.
 */
function avifSize(bytes) {
  const at = bytes.indexOf('ispe', 0, 'latin1');
  if (at === -1 || at + 16 > bytes.length) return null;
  return { width: bytes.readUInt32BE(at + 8), height: bytes.readUInt32BE(at + 12) };
}

/**
 * Read the transfer characteristic out of an ISO-BMFF `colr` box of type
 * `nclx`. Deliberately the same bounded scan as `scanColrTransfer` in
 * `src/lib/codecs/hdr.ts`, so the generator asserts on exactly the byte the
 * app detects HDR from — if these two ever disagree, the assertion is the
 * thing that should fail.
 */
function colrTransfer(bytes) {
  let at = 0;
  for (;;) {
    const hit = bytes.indexOf('colr', at, 'latin1');
    if (hit === -1) return undefined;
    if (bytes.indexOf('nclx', hit + 4, 'latin1') === hit + 4) {
      return bytes.readUInt16BE(hit + 10);
    }
    at = hit + 4;
  }
}

/** Read a JPEG's first SOF marker for the same reason. */
function jpegSize(bytes) {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    // SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15 carry the frame header.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
  return null;
}

const report = [];

/**
 * Log one output and hold it for the summary. Dimensions are read back out of
 * the bytes that were just written, so the console cannot claim a size the
 * file does not have; `expected` turns that into an assertion, optionally with
 * a byte budget as a third element.
 */
function record(file, bytes, expected, label) {
  const relative = path.relative(ROOT, file);
  const measured =
    bytes[0] === 0xff ? jpegSize(bytes) : (pngSize(bytes) ?? avifSize(bytes));
  const size = label ?? (measured ? `${measured.width}×${measured.height}` : 'n/a');
  const kb = (bytes.length / 1024).toFixed(1);
  report.push({ relative, size, bytes: bytes.length });
  console.log(`  ${relative.padEnd(34)} ${size.padEnd(11)} ${kb.padStart(8)} KB`);
  if (expected && measured && (measured.width !== expected[0] || measured.height !== expected[1])) {
    throw new Error(`${relative}: expected ${expected[0]}×${expected[1]}, got ${size}`);
  }
  if (expected?.[2] && bytes.length > expected[2]) {
    throw new Error(`${relative}: ${kb} KB exceeds the ${(expected[2] / 1024).toFixed(0)} KB budget`);
  }
}

/* -------------------------------------------------------------------------- */
/* 1. Icons + favicon                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Rasterise an SVG through `<canvas>`.
 *
 * The source SVGs carry a `viewBox` but no intrinsic `width`/`height`, which
 * would make Chrome rasterise them at the 300×150 default and then scale the
 * bitmap. Stamping the target size onto the root element first means the
 * vector is rendered at final resolution.
 */
async function renderSvg(browser, svgSource, size) {
  const sized = svgSource.replace(
    /<svg\b([^>]*)>/,
    (_match, attrs) =>
      `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, '')} width="${size}" height="${size}">`,
  );
  const svgUrl = `data:image/svg+xml;base64,${Buffer.from(sized, 'utf8').toString('base64')}`;
  const page = await loadPage(browser, { width: 64, height: 64, html: '<body></body>' });
  try {
    return await page.evaluate(
      async ([url, edge]) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = edge;
        canvas.height = edge;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, edge, edge);
        return canvas.toDataURL('image/png');
      },
      [svgUrl, size],
    );
  } finally {
    await page.close();
  }
}

/**
 * Wrap a PNG in a single-entry ICO container.
 *
 * ICO has allowed PNG payloads since Vista and every current browser reads
 * them, so there is no BMP/DIB encoder here: 6-byte ICONDIR, one 16-byte
 * ICONDIRENTRY, then the PNG verbatim.
 */
function icoFromPng(png, edge) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(1, 4); // image count

  const entry = Buffer.alloc(16);
  entry.writeUInt8(edge >= 256 ? 0 : edge, 0); // width  (0 means 256)
  entry.writeUInt8(edge >= 256 ? 0 : edge, 1); // height
  entry.writeUInt8(0, 2); // palette size: 0 = truecolour
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // payload size
  entry.writeUInt32LE(header.length + entry.length, 12); // payload offset

  return Buffer.concat([header, entry, png]);
}

async function buildIcons(browser) {
  console.log('icons');
  const icon = await fs.readFile(p('public/icons/icon.svg'), 'utf8');
  const maskable = await fs.readFile(p('public/icons/icon-maskable.svg'), 'utf8');

  for (const [source, size, name] of [
    [icon, 192, 'icon-192.png'],
    [icon, 512, 'icon-512.png'],
    [maskable, 512, 'icon-maskable-512.png'],
  ]) {
    const file = p('public/icons', name);
    const bytes = await writeDataUrl(file, await renderSvg(browser, source, size));
    record(file, bytes, [size, size, 50 * 1024]);
  }

  const faviconPng = Buffer.from((await renderSvg(browser, icon, 32)).split(',')[1], 'base64');
  const ico = icoFromPng(faviconPng, 32);
  const faviconFile = p('public/favicon.ico');
  await fs.writeFile(faviconFile, ico);
  record(faviconFile, ico, null, '32×32');
}

/* -------------------------------------------------------------------------- */
/* 1b. macOS app icon (icon.icns + the Tauri PNG conventions)                 */
/* -------------------------------------------------------------------------- */

/** The seven renders `iconutil` wants, shared by the ten `.iconset` slots below. */
const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024];

/**
 * `iconutil`'s `.iconset` naming convention: five base sizes, each with a
 * `@2x` slot filled by the next size up. That is ten filenames drawn from
 * only seven distinct renders — 32, 256 and 512 each fill two slots, once as
 * a native size and once as the retina slot for the size below it.
 */
const ICONSET_SLOTS = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

/** The flat PNGs Tauri's `bundle.icon` array names directly, alongside the .icns. */
const TAURI_PNG_SLOTS = [
  ['icon.png', 512],
  ['32x32.png', 32],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
];

async function buildMacosIcons(browser) {
  console.log('macos');
  if (process.platform !== 'darwin') {
    throw new Error(
      'The macos target shells out to `iconutil`, which ships only with macOS. Run this on a Mac, or skip the target elsewhere: node scripts/generate-assets.mjs icons og demo shots',
    );
  }

  const source = await fs.readFile(p('public/icons/icon.svg'), 'utf8');

  // Render each distinct edge once and keep it keyed by size, so the ten
  // .iconset filenames and four Tauri filenames reuse these seven rasterisations
  // instead of asking Chrome to redraw a size it already drew.
  const renders = new Map();
  for (const size of ICNS_SIZES) {
    const dataUrl = await renderSvg(browser, source, size);
    renders.set(size, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  }

  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinch-iconset-'));
  const iconsetDir = path.join(stagingDir, 'icon.iconset');
  await fs.mkdir(iconsetDir, { recursive: true });
  try {
    for (const [name, size] of ICONSET_SLOTS) {
      await fs.writeFile(path.join(iconsetDir, name), renders.get(size));
    }

    const icnsFile = p('src-tauri/icons/icon.icns');
    execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsFile]);
    record(icnsFile, await fs.readFile(icnsFile), null, `${ICNS_SIZES.length} sizes`);
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }

  for (const [name, size] of TAURI_PNG_SLOTS) {
    const file = p('src-tauri/icons', name);
    const bytes = renders.get(size);
    await fs.writeFile(file, bytes);
    record(file, bytes, [size, size]);
  }
}

/* -------------------------------------------------------------------------- */
/* 2. Open Graph card                                                          */
/* -------------------------------------------------------------------------- */

function ogHtml(fonts) {
  const codecs = WASM_ENCODER_LABELS.map((label) => `<span class="chip">${label}</span>`).join('');
  return `<style>
${fonts}
*{margin:0;padding:0;box-sizing:border-box}
body{width:1200px;height:630px;background:${PAPER};color:${INK};
  font-family:'Archivo',system-ui,sans-serif;-webkit-font-smoothing:antialiased;
  display:flex;flex-direction:column;overflow:hidden}
.sheet{flex:1;padding:56px 68px 34px;display:flex;flex-direction:column}
.top{display:flex;align-items:center;gap:16px}
.dot{width:32px;height:32px;border-radius:9px;background:${BLUE};border:2.5px solid ${INK}}
.mark{font-family:'Space Mono',monospace;font-weight:700;font-size:25px;letter-spacing:.34em}
.rule{margin-left:auto;font-family:'Space Mono',monospace;font-size:17px;letter-spacing:.2em;
  color:rgb(20 20 20 / 55%)}
h1{margin-top:42px;font-weight:900;font-size:94px;line-height:.94;letter-spacing:-.035em}
p{margin-top:26px;font-size:28px;line-height:1.36;max-width:880px;color:rgb(20 20 20 / 62%)}
p b{font-weight:700;color:${INK}}
.chips{margin-top:auto;display:flex;flex-direction:column;align-items:flex-start;gap:13px}
.row{display:flex;gap:11px}
.chip{font-family:'Space Mono',monospace;font-size:17px;letter-spacing:.14em;padding:9px 17px 8px;
  border:1.5px solid ${INK};border-radius:999px;background:${SURFACE};white-space:nowrap}
.chip.blue{background:${BLUE};color:${CREAM};border-color:${INK}}
.chip.green{color:${GREEN}}
.chip.purple{color:${PURPLE}}
.strip{height:72px;background:${YELLOW};border-top:1.5px solid ${INK};display:flex;align-items:center;
  justify-content:space-between;padding:0 68px;font-family:'Space Mono',monospace;font-weight:700;
  font-size:18px;letter-spacing:.2em}
.diamond{width:14px;height:14px;background:${INK};transform:rotate(45deg);margin-right:16px}
.strip span{display:flex;align-items:center}
</style>
<div class="sheet">
  <div class="top">
    <i class="dot"></i><span class="mark">PINCH</span>
    <span class="rule">IMAGE COMPRESSION</span>
  </div>
  <h1>Compress images<br>in your browser.</h1>
  <p><b>Nothing is uploaded.</b> Every codec runs locally, and you see exactly what
     you are trading away before you download.</p>
  <div class="chips">
    <div class="row">${codecs}</div>
    <div class="row"><span class="chip">HEIC INPUT</span><span class="chip blue">SSIM VERDICTS</span><span class="chip green">BATCH + ZIP</span><span class="chip purple">WORKS OFFLINE</span></div>
  </div>
</div>
<div class="strip">
  <span><i class="diamond"></i>100% CLIENT-SIDE · WEBASSEMBLY · NO ACCOUNT</span>
  <span>OPEN SOURCE · MIT</span>
</div>`;
}

async function buildOg(browser, fonts) {
  console.log('og');
  const page = await loadPage(browser, { width: 1200, height: 630, html: ogHtml(fonts) });
  try {
    const file = p('public/og.png');
    await page.screenshot({ path: file, type: 'png' });
    record(file, await fs.readFile(file), [1200, 630, 300 * 1024]);
  } finally {
    await page.close();
  }
}

/* -------------------------------------------------------------------------- */
/* 3. Demo rasters                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Four synthetic samples to compress, painted as one editorial series on the
 * shared `POSTER` chassis so the home screen reads as a set rather than four
 * unrelated pictures. Painting them here means the repo owns every byte: no
 * stock photo, no licence question, no download.
 *
 * Each one still covers a different case for the codecs to work on:
 *
 * - `demo-gradient.jpg` — continuous tone. A duotone field, roughly half the
 *   sheet, carrying a diagonal gradient and seeded film grain. Grain is what
 *   makes a file behave like a photograph under a codec — expensive to store,
 *   cheap to lose — so the quality slider has something real to trade against.
 *   Shipped at q0.86, up from the q0.80 the old sunset used: the sheet now has
 *   ink edges on cream, and a demo should not be one codec fighting another
 *   codec's artefacts. Checked against q0.82 and q0.90 by eye at 5× on the
 *   disc outline and the hairline block — q0.90 bought no visible improvement
 *   for its extra 36 KB, and these files sit in the SW precache.
 * - `demo-poster.png` — flat artwork. Large areas of solid colour and hard
 *   edges, i.e. the case where PNG/lossless wins and JPEG rings.
 * - `demo-vector.svg` — the vector case. Hand-authored in `public/demo/`
 *   instead of painted here, and deliberately free of live text: an SVG
 *   rendered through `<img>` cannot reach the page's `@font-face`, so any type
 *   inside it would fall back to a system font and read off-brand.
 * - `demo-hdr.avif` — the HDR case, and the only sample this file cannot paint
 *   on its own. Built by the separate `hdr` target below, which reuses this
 *   exact composition and gives it real highlight headroom. See `buildHdr`.
 *
 * The dominant accent of each piece matches the accent its card uses in
 * `HomeView.svelte` — blue, red, green in order.
 */

/**
 * Paint the gradient sample and hand back a `data:` URL in the requested
 * format, or — for `type: 'raw'` — base64 of the raw RGBA bytes, which is how
 * `buildHdr` gets the pixels out of the browser without a PNG decoder in here.
 *
 * The screenshot step re-paints it losslessly (`image/png`) to stand in for
 * the everyday "I exported a photo as PNG" case — recompressing the shipped
 * JPEG instead would demo a codec fighting another codec's artefacts.
 */
async function paintGradient(page, { width, height, type, quality }) {
  return page.evaluate(
    async ([w, h, mime, q, c, G, P, faces]) => {
      await Promise.all(faces.map((face) => document.fonts.load(face)));

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');

      const { inset, frame } = G;
      const stroke = (width) => {
        ctx.strokeStyle = c.ink;
        ctx.lineWidth = width;
      };

      ctx.fillStyle = c.paper;
      ctx.fillRect(0, 0, w, h);

      // The continuous-tone payload. Everything else on the sheet is flat, so
      // this field is what the quality slider actually trades against; it is
      // sized to about half the canvas for that reason. Its right and bottom
      // edges land on the frame's centreline, which paints over them last.
      const { fx, fy, fw, fh } = G;

      const field = ctx.createLinearGradient(fx, fy, fx + fw, fy + fh);
      field.addColorStop(0, c.blue);
      field.addColorStop(0.52, c.purple);
      field.addColorStop(1, c.red);
      ctx.fillStyle = field;
      ctx.fillRect(fx, fy, fw, fh);

      // A wide cream glow inside the field: more smooth tonal variation for a
      // codec to smear, at no cost in flat area.
      ctx.save();
      ctx.beginPath();
      ctx.rect(fx, fy, fw, fh);
      ctx.clip();
      const glow = ctx.createRadialGradient(fx, h * 0.42, 0, fx, h * 0.42, h * 0.62);
      glow.addColorStop(0, 'rgba(244,238,224,0.6)');
      glow.addColorStop(0.55, 'rgba(244,238,224,0.13)');
      glow.addColorStop(1, 'rgba(244,238,224,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(fx, fy, fw, fh);
      ctx.restore();

      // Film grain, clipped to the field so the paper stays flat and cheap.
      // Kept light (±5 levels at most) and luminance-weighted so the darkest
      // corner stays cleaner: heavier grain is high-frequency noise that every
      // lossy codec discards, which drags SSIM down for a reason that says
      // nothing about the codec.
      //
      // Seeded (mulberry32), not `Math.random`: the output is committed, so
      // re-running this script must produce the same bytes rather than a diff
      // every time.
      let seed = 0x9e3779b9;
      const random = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const region = ctx.getImageData(fx, fy, fw, fh);
      const px = region.data;
      for (let i = 0; i < px.length; i += 4) {
        const luma = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
        const noise = (random() - 0.5) * 10 * (0.35 + luma * 0.9);
        px[i] = Math.max(0, Math.min(255, px[i] + noise));
        px[i + 1] = Math.max(0, Math.min(255, px[i + 1] + noise));
        px[i + 2] = Math.max(0, Math.min(255, px[i + 2] + noise));
      }
      ctx.putImageData(region, fx, fy);

      // Ink on the two field edges that meet paper; the frame covers the rest.
      stroke(frame);
      ctx.beginPath();
      ctx.moveTo(fx, h - inset);
      ctx.lineTo(fx, fy);
      ctx.lineTo(w - inset, fy);
      ctx.stroke();

      // A flat cream disc straddling the field's left edge: one crisp boundary
      // running straight through a smooth gradient, which is where a lossy
      // codec shows its ringing first. Painted after the grain so the disc
      // itself stays clean.
      ctx.beginPath();
      ctx.arc(G.moon.x, G.moon.y, G.moon.r, 0, Math.PI * 2);
      ctx.fillStyle = c.cream;
      ctx.fill();
      ctx.stroke();

      // Yellow quarter-disc in the top-left corner, echoing the blue one on
      // the flat poster.
      ctx.beginPath();
      ctx.moveTo(G.sun.x, G.sun.y);
      ctx.arc(G.sun.x, G.sun.y, G.sun.r, 0, Math.PI / 2);
      ctx.closePath();
      ctx.fillStyle = c.yellow;
      ctx.fill();
      ctx.stroke();

      // Hairline rules — the fine detail a lossy codec smears first.
      const textX = inset + Math.round(w * 0.03);
      stroke(Math.max(1, Math.round(w * P.hairline)));
      for (let i = 0; i < 10; i += 1) {
        const y = h * 0.6 + i * h * 0.011;
        ctx.beginPath();
        ctx.moveTo(textX, y);
        ctx.lineTo(w * 0.34, y);
        ctx.stroke();
      }

      ctx.fillStyle = c.ink;
      ctx.font = `700 ${Math.round(h * P.display)}px 'Archivo', sans-serif`;
      ctx.fillText('TONE', textX, h * 0.52);
      ctx.font = `${Math.round(h * P.caption)}px 'Space Mono', monospace`;
      ctx.fillText('PINCH · SAMPLE 01 · GRADIENT', textX, h * 0.935);

      // Frame last, so shapes that run into it are cropped by the rule rather
      // than painting over it.
      stroke(frame);
      ctx.strokeRect(inset, inset, w - inset * 2, h - inset * 2);

      if (mime !== 'raw') return canvas.toDataURL(mime, q);

      // Raw RGBA, base64'd in chunks: `String.fromCharCode(...bytes)` on a
      // 7.7 MB buffer overflows the argument stack.
      const bytes = ctx.getImageData(0, 0, w, h).data;
      let ascii = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        ascii += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return btoa(ascii);
    },
    [
      width,
      height,
      type,
      quality,
      { ink: INK, paper: PAPER, cream: CREAM, blue: BLUE, purple: PURPLE, red: RED, yellow: YELLOW },
      gradientGeometry(width, height, POSTER),
      POSTER,
      POSTER_FACES,
    ],
  );
}

/** Paint the flat poster sample and hand back a lossless PNG `data:` URL. */
async function paintPoster(page, { width, height }) {
  return page.evaluate(
    async ([w, h, c, P, faces]) => {
      await Promise.all(faces.map((face) => document.fonts.load(face)));

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = c.paper;
      ctx.fillRect(0, 0, w, h);

      const stroke = (width) => {
        ctx.strokeStyle = c.ink;
        ctx.lineWidth = width;
      };

      const inset = Math.round(w * P.inset);
      const frame = Math.round(w * P.frame);

      // Blue quarter-disc, anchored in the top-left corner of the frame.
      ctx.beginPath();
      ctx.moveTo(inset, inset);
      ctx.arc(inset, inset, Math.round(w * 0.25), 0, Math.PI / 2);
      ctx.closePath();
      ctx.fillStyle = c.blue;
      ctx.fill();
      stroke(frame);
      ctx.stroke();

      // Red circle, top-right.
      ctx.beginPath();
      ctx.arc(w * 0.68, h * 0.29, 170, 0, Math.PI * 2);
      ctx.fillStyle = c.red;
      ctx.fill();
      ctx.stroke();

      // Yellow bar, capped by a purple half-disc at its right end.
      const barY = h * 0.58;
      const barH = 104;
      const barX = w * 0.09;
      const barW = w * 0.52;
      ctx.beginPath();
      ctx.arc(barX + barW, barY + barH / 2, barH / 2 + 46, -Math.PI / 2, Math.PI / 2);
      ctx.closePath();
      ctx.fillStyle = c.purple;
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = c.yellow;
      ctx.fillRect(barX, barY, barW, barH);
      ctx.strokeRect(barX, barY, barW, barH);

      // Green triangle, bottom-right.
      ctx.beginPath();
      ctx.moveTo(w * 0.66, h * 0.9);
      ctx.lineTo(w * 0.9, h * 0.9);
      ctx.lineTo(w * 0.78, h * 0.71);
      ctx.closePath();
      ctx.fillStyle = c.green;
      ctx.fill();
      ctx.stroke();

      // Hairline rules — the fine detail a lossy codec smears first.
      stroke(Math.max(1, Math.round(w * P.hairline)));
      for (let i = 0; i < 10; i += 1) {
        const y = h * 0.77 + i * 10;
        ctx.beginPath();
        ctx.moveTo(barX, y);
        ctx.lineTo(w * 0.5, y);
        ctx.stroke();
      }

      ctx.fillStyle = c.ink;
      ctx.font = `700 ${Math.round(h * P.display)}px 'Archivo', sans-serif`;
      ctx.fillText('FLAT', barX + 4, h * 0.5);
      ctx.font = `${Math.round(h * P.caption)}px 'Space Mono', monospace`;
      ctx.fillText('PINCH · SAMPLE 02 · GEOMETRIC', barX + 4, h * 0.935);

      // Frame last, so shapes that run into it are cropped by the rule
      // rather than painting over it.
      stroke(frame);
      ctx.strokeRect(inset, inset, w - inset * 2, h - inset * 2);

      return canvas.toDataURL('image/png');
    },
    [
      width,
      height,
      {
        paper: PAPER,
        ink: INK,
        blue: BLUE,
        red: RED,
        yellow: YELLOW,
        purple: PURPLE,
        green: GREEN,
      },
      POSTER,
      POSTER_FACES,
    ],
  );
}

async function buildDemos(browser, fonts) {
  console.log('demo');
  // The fonts have to be inlined even though nothing is laid out in the DOM:
  // `paintGradient`/`paintPoster` load the faces themselves before drawing.
  const page = await loadPage(browser, {
    width: 64,
    height: 64,
    html: `<style>${fonts}</style><body></body>`,
  });
  try {
    const gradient = await paintGradient(page, {
      width: 1600,
      height: 1200,
      type: 'image/jpeg',
      quality: 0.86,
    });
    const gradientFile = p('public/demo/demo-gradient.jpg');
    // Budgets sit just above what the current art measures (138 KB / 57 KB):
    // these files ship in the service worker's precache, so a composition that
    // suddenly doubles in size should fail the run rather than land quietly.
    record(gradientFile, await writeDataUrl(gradientFile, gradient), [1600, 1200, 170 * 1024]);

    const poster = await paintPoster(page, { width: 1200, height: 900 });
    const posterFile = p('public/demo/demo-poster.png');
    record(posterFile, await writeDataUrl(posterFile, poster), [1200, 900, 70 * 1024]);
  } finally {
    await page.close();
  }
}

/* -------------------------------------------------------------------------- */
/* 4. Demo PDF report                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `demo-report.pdf` — a two-page "report" that gives the PDF compression
 * feature something real to chew on, built from the two rasters `buildDemos`
 * just wrote rather than painted fresh, so the PDF and image samples are
 * visibly the same series.
 *
 * Page 1 embeds `demo-gradient.jpg` as-is: pdf-lib copies a JPEG's bytes
 * straight into a `DCTDecode` stream without re-encoding, so this exercises
 * that path unchanged. Page 2 embeds `demo-poster.png`; pdf-lib has no PNG
 * passthrough — it decodes to raw samples and re-deflates them — so this
 * embeds as `FlateDecode`, the other filter the feature can recompress. Both
 * are drawn about 5 inches wide (`DRAW_WIDTH_PT`) against source raster sizes
 * (1600×1200, 1200×900) more than three times that on the long edge, so each
 * lands north of 300 effective DPI — comfortably above
 * `DEFAULT_PDF_SETTINGS.targetDpi` (150), so the default compress run visibly
 * resamples both images rather than leaving them untouched.
 *
 * Determinism matters here as much as for the rasters (see the module doc):
 * title/author/creator/producer and both dates are pinned rather than left to
 * pdf-lib's defaults (which stamp the actual run time), and the save uses
 * `useObjectStreams: false` — pdf-lib's packed object streams have been
 * observed to reorder between otherwise-identical runs, which a plain
 * cross-reference table does not.
 *
 * Size budget: the JPEG passes through unchanged (141 KB) but the PNG does
 * not — `PngEmbedder` decodes it to raw RGB and re-deflates that, and on a
 * mostly-flat poster raw-sample deflate beats the source PNG's own filtered
 * IDAT stream, landing near 30 KB instead of the source file's 58 KB. Measured
 * total is ~170 KB; the budget below is generous around that, not the 400-700
 * KB a naive byte-for-byte estimate would suggest.
 */
const PDF_DRAW_WIDTH_PT = 360; // 5in at 72pt/in
const PDF_FIXED_DATE = new Date('2026-01-01T00:00:00Z');

async function buildPdfReport() {
  console.log('pdf');
  const [gradientJpg, posterPng] = await Promise.all([
    fs.readFile(p('public/demo/demo-gradient.jpg')),
    fs.readFile(p('public/demo/demo-poster.png')),
  ]);

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle('Pinch Demo Report');
  pdfDoc.setAuthor('Pinch');
  pdfDoc.setCreator('Pinch demo asset generator');
  pdfDoc.setProducer('Pinch');
  pdfDoc.setCreationDate(PDF_FIXED_DATE);
  pdfDoc.setModificationDate(PDF_FIXED_DATE);

  const caption = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const drawFigure = async (image, label) => {
    const page = pdfDoc.addPage(PageSizes.Letter);
    const { width: pageWidth, height: pageHeight } = page.getSize();
    const drawWidth = PDF_DRAW_WIDTH_PT;
    const drawHeight = drawWidth * (image.height / image.width);
    const x = (pageWidth - drawWidth) / 2;
    const y = pageHeight - drawHeight - 144;
    page.drawImage(image, { x, y, width: drawWidth, height: drawHeight });
    page.setFont(caption);
    page.setFontSize(10);
    page.drawText('Pinch Demo Report', { x: 72, y: pageHeight - 72 });
    page.drawText(label, { x: 72, y: y - 24 });
    return page;
  };

  const gradientImage = await pdfDoc.embedJpg(gradientJpg);
  await drawFigure(gradientImage, 'Figure 1. Duotone gradient, embedded as JPEG (DCTDecode).');

  const posterImage = await pdfDoc.embedPng(posterPng);
  await drawFigure(posterImage, 'Figure 2. Flat geometric poster, embedded as PNG (FlateDecode).');

  const bytes = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  const file = p('public/demo/demo-report.pdf');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  record(file, bytes, null, `${pdfDoc.getPageCount()} pages`);

  const kb = bytes.length / 1024;
  if (kb < 120 || kb > 300) {
    throw new Error(
      `${path.relative(ROOT, file)}: ${kb.toFixed(1)} KB outside the expected 120-300 KB budget`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 5. HDR demo raster                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `demo-hdr.avif` — the fourth sample, and the only one the app cannot make
 * itself: a genuine 10-bit PQ (SMPTE ST 2084) AVIF, so the HDR badge in the
 * editor has something honest to fire on.
 *
 * Why it is built like this. A `<canvas>` is 8-bit sRGB and `toDataURL` emits
 * SDR: there is no browser path to PQ, HLG or a gain map. Handing avifenc the
 * SDR pixels with `--cicp 9/16/9` would produce a file that *claims* PQ while
 * carrying no highlight information at all — Pinch would badge it `HDR (PQ)`
 * and every HDR-aware viewer would render it wrong. So the transfer function
 * is applied to real values here instead:
 *
 *   sRGB 8-bit → linear → absolute nits → BT.2020 → ST 2084 → 10-bit Y'CbCr
 *
 * Diffuse surfaces sit at `HDR_REFERENCE_NITS`; the two light sources in the
 * composition — the yellow quarter-disc and the cream disc on the field's edge
 * — are treated as emissive and pushed up to `HDR_PEAK_NITS`. That headroom is what
 * makes the file HDR rather than an SDR image in an HDR container.
 *
 * Opt-in, like `macos`: it shells out to `avifenc` (libavif), which is not an
 * npm dependency, so a bare run must not fail for want of it.
 */

/**
 * Where diffuse white sits. BT.2408 says 203 nits for HDR reference white and
 * this is deliberately not that, for a reason worth writing down.
 *
 * Almost everyone who opens this sample is on an SDR display, so what they
 * actually see is the browser's tone-map of it — and Chrome's puts display
 * white somewhere around 430 nits. At 203 the sheet came back as 182,181,168
 * against the artwork's 251,247,235: a grey wash that reads as a broken
 * decode, not as a demo. Sweeping the value and measuring the decode against
 * the SDR JPEG at four probe points (paper, sun, moon, field) puts the minimum
 * here, at a mean per-channel error of 14/255:
 *
 *   203 → 34/255   300 → 22/255   [400 → 14/255]   500 → 15/255
 *   600 → 16/255   700 → 17/255
 *
 * Past 400 the paper keeps creeping towards white while the field overshoots
 * it, which is why the curve turns back up rather than flattening.
 *
 * The file is still honestly PQ — real ST 2084 values, a real 2× highlight
 * headroom over diffuse white. It is graded for the tone-mapper it will meet
 * rather than for a mastering suite. Re-measure if the artwork changes: this
 * number is a property of the palette, not a constant of nature.
 */
const HDR_REFERENCE_NITS = 400;
/** Peak of the emissive shapes: 2× diffuse white, i.e. real headroom. */
const HDR_PEAK_NITS = 800;

const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** Linear BT.709 → linear BT.2020 (ITU-R BT.2087). */
function bt709ToBt2020(r, g, b) {
  return [
    0.6274039 * r + 0.329283 * g + 0.0433131 * b,
    0.0690797 * r + 0.9195404 * g + 0.0113799 * b,
    0.0163914 * r + 0.0880132 * g + 0.8955953 * b,
  ];
}

/** ST 2084 inverse EOTF: absolute nits → PQ code value in 0..1. */
function pqFromNits(nits) {
  const m1 = 2610 / 16384;
  const m2 = (2523 / 4096) * 128;
  const c1 = 3424 / 4096;
  const c2 = (2413 / 4096) * 32;
  const c3 = (2392 / 4096) * 32;
  const y = Math.max(0, Math.min(1, nits / 10000)) ** m1;
  return ((c1 + c2 * y) / (1 + c3 * y)) ** m2;
}

/**
 * How much brighter than reference white a pixel is, from the composition's
 * own geometry rather than from its luminance. Luminance is the wrong signal
 * here: the paper is the brightest thing on the sheet, and blowing a whole
 * cream background to 800 nits would be an eye-watering file, not an HDR one.
 *
 * Both shapes ramp down to 1 at their rim so the highlight has a shoulder
 * instead of a hard step, which is also kinder to the encoder.
 */
function emissiveGain(x, y, { sun, moon }) {
  const peak = HDR_PEAK_NITS / HDR_REFERENCE_NITS;
  const sunD = Math.hypot(x - sun.x, y - sun.y) / sun.r;
  if (sunD <= 1) return 1 + (peak - 1) * (1 - sunD ** 2);
  // The moon is cream, not white: half the sun's headroom reads as moonlight
  // rather than a second sun.
  const moonD = Math.hypot(x - moon.x, y - moon.y) / moon.r;
  if (moonD <= 1) return 1 + (peak / 2 - 1) * (1 - moonD ** 2);
  return 1;
}

/** Wrap three 10-bit planes as a full-range 4:4:4 y4m, which avifenc reads. */
function y4m444p10(width, height, luma, cb, cr) {
  const plane = (samples) => {
    const out = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i += 1) out.writeUInt16LE(samples[i], i * 2);
    return out;
  };
  return Buffer.concat([
    Buffer.from(
      `YUV4MPEG2 W${width} H${height} F25:1 Ip A1:1 C444p10 XCOLORRANGE=FULL\nFRAME\n`,
      'latin1',
    ),
    plane(luma),
    plane(cb),
    plane(cr),
  ]);
}

async function buildHdr(browser, fonts) {
  console.log('hdr');
  try {
    execFileSync('avifenc', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error(
      'The `hdr` target needs avifenc (libavif) on PATH — `brew install libavif`.\n' +
        'Every other target runs without it; skip this one to rebuild the rest.',
    );
  }

  const width = 1600;
  const height = 1200;
  const geometry = gradientGeometry(width, height, POSTER);

  const page = await loadPage(browser, {
    width: 64,
    height: 64,
    html: `<style>${fonts}</style><body></body>`,
  });
  let rgba;
  try {
    // Same painter, same composition, same seeded grain as the JPEG sample —
    // this is that picture with headroom, not a different one.
    rgba = Buffer.from(await paintGradient(page, { width, height, type: 'raw' }), 'base64');
  } finally {
    await page.close();
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(`hdr: expected ${width * height * 4} raw bytes, got ${rgba.length}`);
  }

  const count = width * height;
  const luma = new Uint16Array(count);
  const cb = new Uint16Array(count);
  const cr = new Uint16Array(count);
  const clamp10 = (v) => Math.max(0, Math.min(1023, Math.round(v)));
  let peak = 0;

  for (let i = 0; i < count; i += 1) {
    const gain = emissiveGain(i % width, Math.floor(i / width), geometry);
    const [r2020, g2020, b2020] = bt709ToBt2020(
      srgbToLinear(rgba[i * 4] / 255) * gain,
      srgbToLinear(rgba[i * 4 + 1] / 255) * gain,
      srgbToLinear(rgba[i * 4 + 2] / 255) * gain,
    );
    peak = Math.max(
      peak,
      r2020 * HDR_REFERENCE_NITS,
      g2020 * HDR_REFERENCE_NITS,
      b2020 * HDR_REFERENCE_NITS,
    );

    const rp = pqFromNits(r2020 * HDR_REFERENCE_NITS);
    const gp = pqFromNits(g2020 * HDR_REFERENCE_NITS);
    const bp = pqFromNits(b2020 * HDR_REFERENCE_NITS);

    // BT.2020 non-constant luminance (CICP matrix 9), full range.
    const y = 0.2627 * rp + 0.678 * gp + 0.0593 * bp;
    luma[i] = clamp10(y * 1023);
    cb[i] = clamp10(((bp - y) / 1.8814) * 1023 + 512);
    cr[i] = clamp10(((rp - y) / 1.4746) * 1023 + 512);
  }

  const scratch = path.join(os.tmpdir(), `pinch-hdr-${process.pid}.y4m`);
  const file = p('public/demo/demo-hdr.avif');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(scratch, y4m444p10(width, height, luma, cb, cr));
  try {
    execFileSync(
      'avifenc',
      [
        // Primaries 9 (BT.2020), transfer 16 (PQ), matrix 9 (BT.2020 NCL) —
        // the transfer is the byte `detectHdr` reads.
        ...['--cicp', '9/16/9'],
        ...['--depth', '10', '--yuv', '444', '--range', 'full'],
        // q90. This is a sample to re-compress, so the grain has to survive
        // the trip in: measured as the sigma of a high-pass over a flat patch
        // of the field, the source grain is 4.86 (10-bit levels) and decodes
        // back at 3.85 here. q82 collapses it to 0.39 — a tone sample with no
        // tone left — and q95 only recovers 4.55 for another 137 KB, which
        // these files, sitting in the SW precache, do not get to spend.
        ...['--qcolor', '90', '--qalpha', '90', '--speed', '4'],
        '--ignore-exif',
        '--ignore-xmp',
        scratch,
        file,
      ],
      { stdio: 'ignore' },
    );
  } finally {
    await fs.rm(scratch, { force: true });
  }

  const bytes = await fs.readFile(file);
  const transfer = colrTransfer(bytes);
  if (transfer !== 16) {
    throw new Error(
      `${path.relative(ROOT, file)}: colr/nclx transfer is ${transfer ?? 'absent'}, expected 16 (PQ).\n` +
        'Without it `detectHdr` in src/lib/codecs/hdr.ts sees an ordinary AVIF and the badge never fires.',
    );
  }
  record(file, bytes, [width, height, 105 * 1024]);
  console.log(`  ${''.padEnd(34)} PQ, 10-bit, peak ${peak.toFixed(0)} nits`);
}

/* -------------------------------------------------------------------------- */
/* 6. Documentation screenshots                                                */
/* -------------------------------------------------------------------------- */

async function findFreePort(start = 4590, tries = 80) {
  for (let port = start; port < start + tries; port += 1) {
    const free = await new Promise((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error(`No free port in ${start}..${start + tries}`);
}

/** Boot `vite` (dev, so no build step is required) and wait for it to answer. */
async function startDevServer(port) {
  const child = spawn(process.execPath, [p('node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => (log += chunk));
  child.stderr.on('data', (chunk) => (log += chunk));

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`vite exited early:\n${log}`);
    try {
      const response = await fetch(`http://localhost:${port}/`);
      if (response.ok) return child;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`vite did not come up on :${port}\n${log}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

async function buildScreenshots(browser) {
  console.log('shots');
  const port = await findFreePort();
  const server = await startDevServer(port);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);
    // Sample thumbnails are lazy-loaded; give them a beat before the shutter.
    await page.waitForTimeout(1500);

    const home = p('docs/media/home.png');
    await fs.mkdir(path.dirname(home), { recursive: true });
    // Taller than the editor shot on purpose: the sample grid is 2×2 since the
    // HDR sample joined it, and at 900px the second row is cut in half. A
    // screenshot of the home screen that crops the samples section is worse
    // than one that is not exactly viewport-shaped.
    await page.setViewportSize({ width: 1440, height: 1010 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: home });
    record(home, await fs.readFile(home), [1440, 1010]);
    await page.setViewportSize({ width: 1440, height: 900 });

    // Feed the real pipeline a lossless PNG of the gradient sample — an
    // ordinary photo export, i.e. what someone actually drops on the app.
    // Every number in the resulting shot (bytes, %, SSIM, verdict) is computed
    // by the app itself; nothing here stages them.
    const source = path.join(os.tmpdir(), 'pinch-assets', 'demo-gradient.png');
    await writeDataUrl(
      source,
      await paintGradient(page, { width: 1600, height: 1200, type: 'image/png' }),
    );
    await page.locator('input[type=file]').first().setInputFiles(source);

    // SSIM is the last number to arrive, so it doubles as "everything has
    // settled" — encode, decode and metrics are all done by then.
    const ssimSettled = () =>
      page.waitForFunction(() => /SSIM[\s\S]{0,40}0\.\d{2}/.test(document.body.innerText), null, {
        timeout: 180_000,
      });
    await ssimSettled();
    await page.waitForTimeout(2500);

    const editor = p('docs/media/editor.png');
    await page.screenshot({ path: editor });
    record(editor, await fs.readFile(editor), [1440, 900]);

    // The PDF screen, using the bundled two-page report — the same file the demo
    // card on the home screen loads, so the shot shows what a reader can click.
    // Nothing is pressed: the view analyses and compresses on mount, then
    // rasterises page 1 of both documents on its own.
    //
    // Taller than the editor shot, for the same reason home.png is: the preview
    // stage takes what the rail and the table leave it, and at 900px a portrait
    // page fits to about a fifth of the width and the shot is mostly empty bed.
    // The extra height goes to the pages, which are the point of the screen.
    //
    // 1100 and not more, deliberately. The result strip below the actions row
    // ends in `Took {n} ms`, which is a stopwatch reading — it differs on every
    // run, and this target's whole contract is that a second run reproduces the
    // first byte for byte. The frame stops above it.
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.locator('input[type=file]').first().setInputFiles(p('public/demo/demo-report.pdf'));

    // Wait for the run AND for both panes to have real pixels. The canvases are
    // in the DOM from the first frame, so their presence proves nothing; an
    // unpainted one would photograph as an empty bed. Same check as
    // `e2e/pdf.smoke.spec.ts`, for the same reason.
    await page.locator('.pdf-result .figure').first().waitFor({ timeout: 180_000 });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.pdf-preview canvas')].every((canvas) => {
          if (!canvas.width || !canvas.height) return false;
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
            .data;
          const first = `${pixels[0]},${pixels[1]},${pixels[2]}`;
          for (let i = 4; i < pixels.length; i += 4 * 499) {
            if (`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}` !== first) return true;
          }
          return false;
        }),
      null,
      { timeout: 180_000 },
    );
    await page.waitForTimeout(1200);

    const pdf = p('docs/media/pdf.png');
    await page.screenshot({ path: pdf });
    record(pdf, await fs.readFile(pdf), [1440, 1100]);
  } finally {
    await page.close();
    server.kill();
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

const ALL = ['icons', 'macos', 'og', 'demo', 'pdf', 'hdr', 'shots'];
// `macos` shells out to `iconutil` (macOS-only) and `hdr` to `avifenc`
// (libavif, not an npm dependency). Both are opt-in: a bare, argument-less run
// must keep working for contributors on any platform with nothing but
// `npm install`, so they stay out of the implied "everything" set and have to
// be named explicitly. `pdf` needs neither, so it is not opt-in.
const OPT_IN = ['macos', 'hdr'];
const DEFAULT = ALL.filter((target) => !OPT_IN.includes(target));
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const targets = requested.length ? requested : DEFAULT;
const unknown = targets.filter((target) => !ALL.includes(target));
if (unknown.length) {
  console.error(`Unknown target(s): ${unknown.join(', ')}. Known: ${ALL.join(', ')}`);
  process.exit(1);
}

// `pdf` reads the rasters `demo` writes, so when both are requested `demo`
// must run first.
if (targets.includes('pdf') && !targets.includes('demo')) {
  await fs.access(p('public/demo/demo-gradient.jpg')).catch(() => {
    throw new Error('pdf target needs public/demo/demo-gradient.jpg — run `demo` first (or with no args).');
  });
}

// Every target except `pdf` renders through headless Chrome; skip the launch
// (and the `CHROME_PATH` requirement that comes with it) when it is the only
// thing requested — `node scripts/generate-assets.mjs pdf` should not need a
// browser installed to touch pdf-lib.
const CHROME_TARGETS = ['icons', 'macos', 'og', 'demo', 'hdr', 'shots'];
const needsBrowser = targets.some((target) => CHROME_TARGETS.includes(target));
const browser = needsBrowser
  ? await chromium.launch({ executablePath: chromeExecutable(), headless: true })
  : null;
try {
  const fonts = needsBrowser ? await fontFaceCss() : null;
  if (targets.includes('icons')) await buildIcons(browser);
  if (targets.includes('macos')) await buildMacosIcons(browser);
  if (targets.includes('og')) await buildOg(browser, fonts);
  if (targets.includes('demo')) await buildDemos(browser, fonts);
  if (targets.includes('pdf')) await buildPdfReport();
  if (targets.includes('hdr')) await buildHdr(browser, fonts);
  if (targets.includes('shots')) await buildScreenshots(browser);
} finally {
  if (browser) await browser.close();
}

const total = report.reduce((sum, entry) => sum + entry.bytes, 0);
console.log(`\n${report.length} file(s), ${(total / 1024).toFixed(1)} KB total`);
