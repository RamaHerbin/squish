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
 * Targets: `icons` (+ favicon), `og`, `demo`, `shots`.
 * `shots` boots `vite` on a free port and drives the real app, so it is the
 * slow one; the other three are pure rendering and take a couple of seconds.
 *
 * Outputs (all overwritten in place, all committed):
 *   public/icons/icon-192.png          192×192   from icon.svg
 *   public/icons/icon-512.png          512×512   from icon.svg
 *   public/icons/icon-maskable-512.png 512×512   from icon-maskable.svg
 *   public/favicon.ico                 32×32     PNG-in-ICO container
 *   public/og.png                      1200×630  social card
 *   public/demo/demo-sunset.jpg        1600×1200 synthetic photo, JPEG q0.8
 *   public/demo/demo-poster.png        1200×900  geometric poster, PNG
 *   docs/media/home.png                1440×900  app screenshot
 *   docs/media/editor.png              1440×900  app screenshot
 */

import { spawn } from 'node:child_process';
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
 * Two synthetic images to compress, painted with `<canvas>` so the repo owns
 * every byte (no stock photo, no licence question, no download):
 *
 * - `demo-sunset.jpg`  — layered sky gradient, sun, haze-separated ridges and
 *   film grain. Grain is what makes it behave like a photograph under a
 *   codec: it is expensive to store and cheap to lose, so the quality slider
 *   has something real to trade against.
 * - `demo-poster.png`  — flat geometric artwork on paper. Large areas of
 *   solid colour and hard edges, i.e. the case where PNG/lossless wins and
 *   JPEG rings.
 */
/**
 * Paint the sunset and hand back a `data:` URL in the requested format.
 *
 * The screenshot step re-paints it losslessly (`image/png`) to stand in for
 * the everyday "I exported a photo as PNG" case — recompressing the shipped
 * JPEG instead would demo a codec fighting another codec's artefacts.
 */
async function paintSunset(page, { width, height, type, quality }) {
  return page.evaluate(
    ([w, h, mime, q, palette]) => {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');

        const sky = ctx.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#140b2c');
        sky.addColorStop(0.28, '#3d1550');
        sky.addColorStop(0.5, '#8f2f5e');
        sky.addColorStop(0.68, '#e0603a');
        sky.addColorStop(0.82, '#f79c3d');
        sky.addColorStop(1, '#ffd98a');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, w, h);

        // Sun: a hard disc inside a wide glow, sitting on the horizon line.
        const sunX = w * 0.62;
        const sunY = h * 0.6;
        const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, h * 0.42);
        glow.addColorStop(0, 'rgba(255,246,214,0.95)');
        glow.addColorStop(0.35, 'rgba(255,209,102,0.45)');
        glow.addColorStop(1, 'rgba(255,209,102,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h);
        ctx.beginPath();
        ctx.arc(sunX, sunY, h * 0.105, 0, Math.PI * 2);
        ctx.fillStyle = '#fff3cd';
        ctx.fill();

        // Soft cloud streaks — blurred ellipses, not bands: a hard-edged rect
        // would read as codec banding in the very image meant to demo codecs.
        ctx.save();
        ctx.filter = 'blur(26px)';
        for (let i = 0; i < 6; i += 1) {
          const y = h * (0.14 + i * 0.062);
          ctx.beginPath();
          ctx.ellipse(w * (0.2 + 0.13 * i), y, w * (0.3 - i * 0.02), h * 0.016, 0, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,${196 - i * 6},${168 - i * 8},${0.16 + i * 0.02})`;
          ctx.fill();
        }
        ctx.restore();

        // Four ridges, each one lighter and hazier than the one in front of it.
        // The haze is clipped to the ridge itself so the sky keeps its contrast.
        const ridge = (baseY, amplitude, seed, top, bottom, haze) => {
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(0, h);
          const steps = 96;
          for (let i = 0; i <= steps; i += 1) {
            const x = (w * i) / steps;
            const t = x / w;
            const peak =
              baseY -
              amplitude * Math.abs(Math.sin(t * Math.PI * 1.7 + seed)) -
              amplitude * 0.32 * Math.sin(t * Math.PI * 5.3 + seed * 2) -
              amplitude * 0.14 * Math.sin(t * Math.PI * 11.1 + seed * 3);
            ctx.lineTo(x, peak);
          }
          ctx.lineTo(w, h);
          ctx.closePath();
          ctx.clip();

          const fill = ctx.createLinearGradient(0, baseY - amplitude, 0, h);
          fill.addColorStop(0, top);
          fill.addColorStop(1, bottom);
          ctx.fillStyle = fill;
          ctx.fillRect(0, 0, w, h);

          if (haze > 0) {
            const mist = ctx.createLinearGradient(0, baseY - amplitude * 1.2, 0, baseY + amplitude);
            mist.addColorStop(0, `rgba(255,186,146,${haze})`);
            mist.addColorStop(1, 'rgba(255,186,146,0)');
            ctx.fillStyle = mist;
            ctx.fillRect(0, 0, w, h);
          }
          ctx.restore();
        };
        ridge(h * 0.68, h * 0.11, 0.4, '#8a5a86', '#6b3d70', 0.34);
        ridge(h * 0.76, h * 0.12, 2.1, '#5b3563', '#402548', 0.2);
        ridge(h * 0.85, h * 0.11, 3.7, '#33203c', '#22162a', 0.09);
        ridge(h * 0.94, h * 0.08, 5.2, '#170f1f', '#0c0812', 0);

        // Vignette.
        const vignette = ctx.createRadialGradient(w / 2, h * 0.55, h * 0.2, w / 2, h * 0.55, h * 0.95);
        vignette.addColorStop(0, 'rgba(0,0,0,0)');
        vignette.addColorStop(1, 'rgba(0,0,0,0.42)');
        ctx.fillStyle = vignette;
        ctx.fillRect(0, 0, w, h);

        // Film grain — per-pixel, luminance-weighted so shadows stay cleaner.
        // Kept light (±5 levels at most): heavier grain is high-frequency noise
        // that every lossy codec discards, which drags SSIM down for a reason
        // that says nothing about the codec.
        //
        // Seeded (mulberry32), not `Math.random`: the output is committed, so
        // re-running this script must produce the same bytes rather than a
        // diff every time.
        let seed = 0x9e3779b9;
        const random = () => {
          seed = (seed + 0x6d2b79f5) | 0;
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const frame = ctx.getImageData(0, 0, w, h);
        const px = frame.data;
        for (let i = 0; i < px.length; i += 4) {
          const luma = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
          const noise = (random() - 0.5) * 10 * (0.35 + luma * 0.9);
          px[i] = Math.max(0, Math.min(255, px[i] + noise));
          px[i + 1] = Math.max(0, Math.min(255, px[i + 1] + noise));
          px[i + 2] = Math.max(0, Math.min(255, px[i + 2] + noise));
        }
        ctx.putImageData(frame, 0, 0);

        // Editorial caption plate, bottom-left.
        ctx.fillStyle = palette.ink;
        ctx.fillRect(w * 0.045, h * 0.87, w * 0.3, h * 0.062);
        ctx.fillStyle = palette.cream;
        ctx.font = `${Math.round(h * 0.026)}px 'Space Mono', monospace`;
        ctx.fillText('PINCH · SAMPLE 01', w * 0.062, h * 0.909);

        return canvas.toDataURL(mime, q);
      },
      [width, height, type, quality, { ink: INK, cream: CREAM }],
  );
}

async function buildDemos(browser) {
  console.log('demo');
  const page = await loadPage(browser, { width: 64, height: 64, html: '<body></body>' });
  try {
    const sunset = await paintSunset(page, {
      width: 1600,
      height: 1200,
      type: 'image/jpeg',
      quality: 0.8,
    });
    const sunsetFile = p('public/demo/demo-sunset.jpg');
    record(sunsetFile, await writeDataUrl(sunsetFile, sunset), [1600, 1200]);

    const poster = await page.evaluate(
      ([w, h, c]) => {
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

        const inset = 34;

        // Blue quarter-disc, anchored in the top-left corner of the frame.
        ctx.beginPath();
        ctx.moveTo(inset, inset);
        ctx.arc(inset, inset, 300, 0, Math.PI / 2);
        ctx.closePath();
        ctx.fillStyle = c.blue;
        ctx.fill();
        stroke(6);
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
        stroke(2);
        for (let i = 0; i < 10; i += 1) {
          const y = h * 0.77 + i * 10;
          ctx.beginPath();
          ctx.moveTo(barX, y);
          ctx.lineTo(w * 0.5, y);
          ctx.stroke();
        }

        ctx.fillStyle = c.ink;
        ctx.font = `700 ${Math.round(h * 0.085)}px 'Archivo', sans-serif`;
        ctx.fillText('FLAT', barX + 4, h * 0.5);
        ctx.font = `${Math.round(h * 0.024)}px 'Space Mono', monospace`;
        ctx.fillText('PINCH · SAMPLE 02 · GEOMETRIC', barX + 4, h * 0.935);

        // Frame last, so shapes that run into it are cropped by the rule
        // rather than painting over it.
        stroke(6);
        ctx.strokeRect(inset, inset, w - inset * 2, h - inset * 2);

        return canvas.toDataURL('image/png');
      },
      [
        1200,
        900,
        { paper: PAPER, ink: INK, blue: BLUE, red: RED, yellow: YELLOW, purple: PURPLE, green: GREEN },
      ],
    );
    const posterFile = p('public/demo/demo-poster.png');
    record(posterFile, await writeDataUrl(posterFile, poster), [1200, 900]);
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

    // Feed the real pipeline a lossless PNG of the sunset — an ordinary photo
    // export, i.e. what someone actually drops on the app. Every number in the
    // resulting shot (bytes, %, SSIM, verdict) is computed by the app itself;
    // nothing here stages them.
    const source = path.join(os.tmpdir(), 'pinch-assets', 'demo-sunset.png');
    await writeDataUrl(
      source,
      await paintSunset(page, { width: 1600, height: 1200, type: 'image/png' }),
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

const ALL = ['icons', 'og', 'demo', 'shots'];
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const targets = requested.length ? requested : ALL;
const unknown = targets.filter((target) => !ALL.includes(target));
if (unknown.length) {
  console.error(`Unknown target(s): ${unknown.join(', ')}. Known: ${ALL.join(', ')}`);
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: chromeExecutable(), headless: true });
try {
  const fonts = await fontFaceCss();
  if (targets.includes('icons')) await buildIcons(browser);
  if (targets.includes('og')) await buildOg(browser, fonts);
  if (targets.includes('demo')) await buildDemos(browser);
  if (targets.includes('shots')) await buildScreenshots(browser);
} finally {
  await browser.close();
}

const total = report.reduce((sum, entry) => sum + entry.bytes, 0);
console.log(`\n${report.length} file(s), ${(total / 1024).toFixed(1)} KB total`);
