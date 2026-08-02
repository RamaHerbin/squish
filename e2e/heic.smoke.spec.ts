import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * HEIC decode smoke test.
 *
 * Chromium has no native HEIC decoder, so loading these fixtures exercises the
 * wasm-path fallback end to end: sniff → codec worker → `heic-to` (libheif) →
 * ImageData → the editor's Original canvas. The fixtures are 10-bit tiled
 * HEICs built to make decoder corruption legible in numbers (see
 * e2e/fixtures/README.md): a neutral grey column where any chroma error shows
 * as R≠G≠B, and four hue quadrants that catch grid tiles landing in the wrong
 * place. libheif-js 1.19.8 shipped exactly that failure for Apple 10-bit 4:4:4
 * bitstreams — scrambled colored tiles — which is why the decoder moved to
 * heic-to and why this net exists.
 *
 * The synthetic fixtures decode cleanly on the OLD decoder too (the Apple
 * 4:4:4 trigger cannot be reproduced with x265 or CoreImage); they guard the
 * pipeline, not that specific bitstream. The gold fixture — a real iPhone
 * screenshot of the same pattern, which IS the triggering class — is asserted
 * whenever it is present, with geometry relative to its device-sized frame.
 *
 * Runs against `vite preview` (see playwright.config.ts) with COOP/COEP, same
 * as the other smoke tests.
 */

const FIXTURES = [
  {
    name: 'Apple CoreImage 10-bit 4:2:0 grid',
    path: fileURLToPath(new URL('./fixtures/heic-10bit-420-apple.heic', import.meta.url)),
  },
  {
    name: 'x265 10-bit 4:4:4 grid with ICC profile',
    path: fileURLToPath(new URL('./fixtures/heic-10bit-444-icc.heic', import.meta.url)),
  },
] as const;

/** Real iPhone screenshot (Apple 4:4:4) — committed once one reproduces. */
const GOLD = fileURLToPath(
  new URL('./fixtures/heic-10bit-444-apple-screenshot.heic', import.meta.url),
);

/** The synthetic fixtures rasterise one 1320×900 pattern (README, recipe). */
const WIDTH = 1320;
const HEIGHT = 900;

/** Console/page errors that mean the decode actually broke. */
const FATAL = [
  /worker sent an error/i,
  /reading 'id'/,
  /WorkerLoadError/,
  /WorkerTimeoutError/,
  /Couldn't decode/i,
];

interface CanvasReport {
  width: number;
  height: number;
  varied: number;
  /** Worst channel spread down the by-construction neutral column. */
  neutralDeviation: number;
  /** [r, g, b] at four probe points, one per hue quadrant. */
  probes: [number, number, number][];
}

interface PatternGeometry {
  /** x of the neutral column, as a fraction of the width. */
  neutralX: number;
  /** y range sampled on the column, as fractions (skips a status bar). */
  neutralYRange: [number, number];
  /** Probe coordinates as fractions of width/height, TL/TR/BL/BR order. */
  probes: [number, number][];
}

/** Probe placement for the committed 1320×900 fixtures: exact pixels. */
const SYNTHETIC: PatternGeometry = {
  neutralX: 660 / WIDTH,
  neutralYRange: [8 / HEIGHT, 892 / HEIGHT],
  probes: [
    [490 / WIDTH, 225 / HEIGHT],
    [990 / WIDTH, 225 / HEIGHT],
    [490 / WIDTH, 675 / HEIGHT],
    [990 / WIDTH, 675 / HEIGHT],
  ],
};

/**
 * The gold screenshot has device-sized dimensions and a status bar burned into
 * the top, so its geometry is relative: the pattern page renders the neutral
 * band across the middle fifth and the quadrant hues around it, and sampling
 * stays clear of the top 15% and bottom 15% (status bar, Safari toolbar).
 */
const GOLD_GEOMETRY: PatternGeometry = {
  neutralX: 0.5,
  neutralYRange: [0.15, 0.85],
  probes: [
    [0.2, 0.3],
    [0.8, 0.3],
    [0.2, 0.8],
    [0.8, 0.8],
  ],
};

/**
 * Read the full-resolution decoded pixels back off the Original canvas.
 *
 * The canvas backing store is the decoded `ImageData` itself (`OutputCanvas`
 * only scales with CSS), so this sees exactly what the decoder produced, at
 * any viewport size. Probes sit far enough inside their quadrants to survive
 * 4:2:0 chroma subsampling at the tile seams.
 */
async function readOriginal(canvas: Locator, geometry: PatternGeometry): Promise<CanvasReport> {
  return canvas.evaluate((element, geo) => {
    const el = element as HTMLCanvasElement;
    const ctx = el.getContext('2d');
    if (!ctx || el.width === 0 || el.height === 0) {
      return { width: el.width, height: el.height, varied: 0, neutralDeviation: 255, probes: [] };
    }

    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    const at = (x: number, y: number): [number, number, number] => {
      const i = (y * el.width + x) * 4;
      return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
    };

    const [r0, g0, b0] = at(0, 0);
    let varied = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== r0 || data[i + 1] !== g0 || data[i + 2] !== b0) varied += 1;
    }

    const columnX = Math.round(geo.neutralX * el.width);
    const yFrom = Math.round((geo.neutralYRange[0] ?? 0) * el.height);
    const yTo = Math.round((geo.neutralYRange[1] ?? 1) * el.height);
    let neutralDeviation = 0;
    for (let y = yFrom; y < yTo; y += 1) {
      const [r, g, b] = at(columnX, y);
      const spread = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));
      if (spread > neutralDeviation) neutralDeviation = spread;
    }

    return {
      width: el.width,
      height: el.height,
      varied,
      neutralDeviation,
      probes: geo.probes.map(([px, py]) =>
        at(Math.round(px * el.width), Math.round(py * el.height)),
      ),
    };
  }, geometry);
}

/** Load one HEIC through the home picker; return pixels + observed URLs. */
async function loadHeic(
  page: Page,
  fixture: string,
  geometry: PatternGeometry,
): Promise<{ report: CanvasReport; observed: string[]; fatal: string[] }> {
  const fatal: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && FATAL.some((re) => re.test(msg.text()))) fatal.push(msg.text());
  });
  page.on('pageerror', (err) => {
    if (FATAL.some((re) => re.test(String(err)))) fatal.push(String(err));
  });

  // The decoder chunk's emitted name is hard-coded in two places (vite.config's
  // globIgnores and sw.ts's runtime-cache route); this spec is the only check
  // that notices the coupling breaking. Watch requests and workers both, as
  // codecs.smoke.spec.ts does.
  const observed: string[] = [];
  page.on('worker', (worker) => observed.push(worker.url()));
  page.on('request', (request) => observed.push(request.url()));

  await page.goto('/');

  const isolated = await page.evaluate(
    () => (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
  );
  expect(isolated, 'page must be cross-origin-isolated like production').toBe(true);

  await page.locator('input.sr-only[type="file"]').setInputFiles(fixture);

  const original = page.locator('canvas[aria-label="Original"]');
  await expect(original).toBeVisible({ timeout: 45_000 });

  // Decode lands asynchronously; poll until the canvas holds a real image.
  await expect
    .poll(async () => (await readOriginal(original, geometry)).varied, { timeout: 45_000 })
    .toBeGreaterThan(10_000);

  return { report: await readOriginal(original, geometry), observed, fatal };
}

/** The assertions shared by every fixture, whatever its dimensions. */
function verifyPattern(
  { report, observed, fatal }: Awaited<ReturnType<typeof loadHeic>>,
  neutralTolerance: number,
): void {
  // The centre column is grey by construction: any spread between channels is
  // chroma corruption. Measured 0–1 on a correct decode of the synthetic
  // fixtures; the 1.19.8 failure class produced spreads well past 32.
  expect(report.neutralDeviation, 'neutral column must stay neutral').toBeLessThanOrEqual(
    neutralTolerance,
  );

  // One dominant hue per quadrant — misassembled grid tiles land the wrong
  // colour under a probe long before they perturb the neutral column.
  const [tl, tr, bl, br] = report.probes;
  if (!tl || !tr || !bl || !br) throw new Error('probe readback failed');
  expect(tl[0], 'top-left leans red').toBeGreaterThan(Math.max(tl[1], tl[2]) + 20);
  expect(tr[1], 'top-right leans green').toBeGreaterThan(Math.max(tr[0], tr[2]) + 20);
  expect(bl[2], 'bottom-left leans blue').toBeGreaterThan(Math.max(bl[0], bl[1]) + 20);
  expect(Math.min(br[0], br[1]), 'bottom-right leans yellow').toBeGreaterThan(br[2] + 40);

  expect(
    observed.some((url) => /\/heic-to-[\w-]+\.js(\?|$)/.test(url)),
    'the heic-to chunk must load under the name sw.ts and vite.config.ts pin',
  ).toBe(true);

  expect(fatal, `fatal console/page errors during HEIC decode:\n${fatal.join('\n')}`).toEqual([]);
}

async function verifySynthetic(page: Page, fixture: string): Promise<void> {
  const result = await loadHeic(page, fixture, SYNTHETIC);
  expect({ width: result.report.width, height: result.report.height }).toEqual({
    width: WIDTH,
    height: HEIGHT,
  });
  verifyPattern(result, 6);
}

for (const { name, path } of FIXTURES) {
  test(`decodes ${name} correctly on desktop`, async ({ page }) => {
    await verifySynthetic(page, path);
  });
}

test.describe('mobile viewport', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  for (const { name, path } of FIXTURES) {
    test(`decodes ${name} correctly at 390×844`, async ({ page }) => {
      await verifySynthetic(page, path);
    });
  }
});

test('decodes a real iPhone screenshot (gold fixture)', async ({ page }) => {
  test.skip(!existsSync(GOLD), 'gold fixture not committed yet — see e2e/fixtures/README.md');
  const result = await loadHeic(page, GOLD, GOLD_GEOMETRY);
  expect(result.report.width, 'a device screenshot is portrait').toBeLessThan(
    result.report.height,
  );
  // JPEG-quality chroma on a real screenshot: looser than the synthetics, still
  // an order of magnitude under the corruption the old decoder produced.
  verifyPattern(result, 12);
});
