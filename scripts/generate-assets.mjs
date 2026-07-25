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
 * `shots`. `shots` boots `vite` on a free port and drives the real app, so it
 * is the slow one; the rest are pure rendering and take a couple of seconds.
 *
 * `macos` is opt-in and excluded from a bare, argument-less run: it shells
 * out to `iconutil`, which only ships with macOS, so it must be named
 * explicitly (`node scripts/generate-assets.mjs macos`) rather than breaking
 * the default "everything" run for contributors on Linux or Windows.
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
 *   docs/media/home.png                1440×900  app screenshot
 *   docs/media/editor.png              1440×900  app screenshot
 */

import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

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
  const measured = bytes[0] === 0xff ? jpegSize(bytes) : pngSize(bytes);
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
 * Three synthetic samples to compress, painted as one editorial series on the
 * shared `POSTER` chassis so the home screen reads as a set rather than three
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
 *
 * The dominant accent of each piece matches the accent its card uses in
 * `HomeView.svelte` — blue, red, green in order.
 */

/**
 * Paint the gradient sample and hand back a `data:` URL in the requested
 * format.
 *
 * The screenshot step re-paints it losslessly (`image/png`) to stand in for
 * the everyday "I exported a photo as PNG" case — recompressing the shipped
 * JPEG instead would demo a codec fighting another codec's artefacts.
 */
async function paintGradient(page, { width, height, type, quality }) {
  return page.evaluate(
    async ([w, h, mime, q, c, P, faces]) => {
      await Promise.all(faces.map((face) => document.fonts.load(face)));

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');

      const inset = Math.round(w * P.inset);
      const frame = Math.round(w * P.frame);
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
      const fx = Math.round(w * 0.4);
      const fy = Math.round(h * 0.12);
      const fw = w - inset - fx;
      const fh = h - inset - fy;

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
      ctx.arc(fx, h * 0.42, Math.round(h * 0.155), 0, Math.PI * 2);
      ctx.fillStyle = c.cream;
      ctx.fill();
      ctx.stroke();

      // Yellow quarter-disc in the top-left corner, echoing the blue one on
      // the flat poster.
      ctx.beginPath();
      ctx.moveTo(inset, inset);
      ctx.arc(inset, inset, Math.round(h * 0.28), 0, Math.PI / 2);
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

      return canvas.toDataURL(mime, q);
    },
    [
      width,
      height,
      type,
      quality,
      { ink: INK, paper: PAPER, cream: CREAM, blue: BLUE, purple: PURPLE, red: RED, yellow: YELLOW },
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
/* 4. Documentation screenshots                                                */
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
    await page.screenshot({ path: home });
    record(home, await fs.readFile(home), [1440, 900]);

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

    // Accept the app's own quality suggestion, so the shot shows a settled,
    // recommended state instead of the untouched default. The pill's button is
    // "Cancel" while the probe is still running and "Applied" afterwards —
    // clicking anything but "Apply" would cancel the suggestion, hence the
    // label check.
    const action = page.locator('.auto-pill button');
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if ((await action.count()) === 0) break;
      const label = (await action.first().innerText()).trim();
      if (/^applied$/i.test(label)) break;
      if (/^apply$/i.test(label)) {
        await action.first().click();
        await page.waitForTimeout(1500);
        await ssimSettled();
        break;
      }
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(2500);

    const editor = p('docs/media/editor.png');
    await page.screenshot({ path: editor });
    record(editor, await fs.readFile(editor), [1440, 900]);
  } finally {
    await page.close();
    server.kill();
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

const ALL = ['icons', 'macos', 'og', 'demo', 'shots'];
// `macos` shells out to `iconutil` (macOS-only) and is opt-in: a bare,
// argument-less run must keep working for contributors on any platform, so
// it stays out of the implied "everything" set and has to be named explicitly.
const DEFAULT = ALL.filter((target) => target !== 'macos');
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const targets = requested.length ? requested : DEFAULT;
const unknown = targets.filter((target) => !ALL.includes(target));
if (unknown.length) {
  console.error(`Unknown target(s): ${unknown.join(', ')}. Known: ${ALL.join(', ')}`);
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: chromeExecutable(), headless: true });
try {
  const fonts = await fontFaceCss();
  if (targets.includes('icons')) await buildIcons(browser);
  if (targets.includes('macos')) await buildMacosIcons(browser);
  if (targets.includes('og')) await buildOg(browser, fonts);
  if (targets.includes('demo')) await buildDemos(browser, fonts);
  if (targets.includes('shots')) await buildScreenshots(browser);
} finally {
  await browser.close();
}

const total = report.reduce((sum, entry) => sum + entry.bytes, 0);
console.log(`\n${report.length} file(s), ${(total / 1024).toFixed(1)} KB total`);
