import { fileURLToPath } from 'node:url';

import { expect, test, type Locator } from '@playwright/test';

/**
 * PDF conversion smoke test.
 *
 * Loads a real PDF through the home file picker, lets the app route it to the
 * PDF view, waits for the embedded-image analysis to populate and for the
 * compress pass the view starts on its own, checks the before/after page
 * preview, and downloads the result. This is the regression net for "a merged PR silently broke the PDF
 * pipeline", and it covers two paths that unit tests cannot reach: the
 * pdf-lib decode-and-rewrite, which only does real work when the wasm codecs
 * actually run, and the pdf.js page preview, which needs a worker and a canvas.
 * Those two are separate — pdf.js only rasterises the preview; it is not part
 * of the rewrite, which is `@cantoo/pdf-lib` plus the codec worker.
 *
 * Runs against `vite preview` (see playwright.config.ts), which sends COOP/COEP,
 * so `crossOriginIsolated` is true and jSquash loads its threaded builds.
 */

const FIXTURE = fileURLToPath(new URL('../public/demo/demo-report.pdf', import.meta.url));

/** Console/page errors that mean the pipeline actually broke (not incidental noise). */
const FATAL = [/worker sent an error/i, /reading 'id'/, /WorkerLoadError/, /WorkerTimeoutError/, /pthread/i];

/**
 * Warnings that are every bit as fatal, kept in their own list because the
 * patterns above are noisy enough that matching them against the whole warning
 * stream would flake.
 *
 * pdf.js does not throw when its worker fails to load. It prints one
 * `console.warn` and rasterises on the main thread instead, so the preview
 * still appears, every assertion below still passes, and the only symptom is a
 * UI that locks up for a second per page. This repo has already shipped one PR
 * about a worker degrading silently; catching this one is the point of the
 * test.
 */
const FATAL_WARNINGS = [/Setting up fake worker/i];

/**
 * What a preview canvas is actually showing.
 *
 * `varied` counts the pixels that differ from the top-left one, which is the
 * only honest definition of "not blank": a canvas that was never drawn to is
 * uniform, whether it came back transparent, white or black. Asserting on the
 * element's existence, or on its size, would pass just as happily against a
 * rasteriser that silently produced nothing.
 *
 * `hash` is an FNV-1a over every byte, so two pages of the same document cannot
 * be mistaken for each other.
 */
async function readCanvas(canvas: Locator): Promise<{ varied: number; hash: number }> {
  return canvas.evaluate((element) => {
    const el = element as HTMLCanvasElement;
    const ctx = el.getContext('2d');
    if (!ctx || el.width === 0 || el.height === 0) return { varied: 0, hash: 0 };

    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    const [r0, g0, b0, a0] = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0];
    let varied = 0;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const a = data[i + 3] ?? 0;
      if (r !== r0 || g !== g0 || b !== b0 || a !== a0) varied += 1;
      hash = Math.imul(hash ^ (r + g * 3 + b * 7 + a * 11), 16777619) >>> 0;
    }
    return { varied, hash };
  });
}

/** Pixels that must differ from the corner before a canvas counts as a page. */
const MIN_VARIED_PIXELS = 10_000;

test('converts a PDF end to end', async ({ page }) => {
  const fatal: string[] = [];
  const record = (text: string, patterns: RegExp[]) => {
    if (patterns.some((re) => re.test(text))) fatal.push(text);
  };
  page.on('console', (msg) => {
    if (msg.type() === 'error') record(msg.text(), FATAL);
    else if (msg.type() === 'warning') record(msg.text(), FATAL_WARNINGS);
  });
  page.on('pageerror', (err) => record(String(err), FATAL));

  await page.goto('/');

  // The threaded codec path is only under test when the page is isolated. If a
  // change drops COOP/COEP, the app would silently fall back to single-thread
  // and hide the very break we are guarding — so assert isolation up front.
  const isolated = await page.evaluate(
    () => (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
  );
  expect(isolated, 'page must be cross-origin-isolated so threaded wasm is exercised').toBe(true);

  // Load a real PDF into the hidden home file input; the home picker routes it
  // to the PDF view rather than rejecting it or treating it as an image.
  await page.locator('input.sr-only[type="file"]').setInputFiles(FIXTURE);

  const pdfView = page.locator('[data-view="pdf"]');
  await expect(pdfView, 'PDF should be routed to the PDF view, not rejected').toBeVisible();

  const rows = page.locator('.pdf-images tbody tr');
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });
  expect(await rows.count(), 'analysis table should have one row per embedded image').toBeGreaterThan(0);

  const trigger = page.getByRole('button', { name: 'Compress', exact: true });
  const download = page.locator('button.download');
  const figure = page.locator('.pdf-result .figure');
  const preview = page.locator('.pdf-preview');

  // Nothing is clicked to get here: the view compresses on mount, at the
  // defaults the rail opens on. Do not press Compress while that run is in
  // flight — the button is a toggle and would abort it. Do not toggle the SSIM
  // measure checkbox either; keep the run fast and deterministic.
  await expect(download).toBeEnabled({ timeout: 45_000 });
  await expect(figure).toHaveText(/\d/, { timeout: 45_000 });

  // The button is now a re-run: it has to come back armed once the automatic
  // pass lands, or changing a setting would leave no way to act on it.
  await expect(trigger, 'Compress should re-arm after the run on mount').toBeEnabled();

  // ------------------------------------------------------------- preview
  // The table above can only say that a stream was replaced. Whether the page
  // still reads as a page is a question about pixels, and this is the only
  // place in the suite where the rasteriser runs at all.
  await expect(preview, 'a finished run should raise the page preview').toBeVisible();
  await expect(preview.locator('.banner')).toHaveCount(0);

  const before = preview.locator('.pane:not(.pane-output) canvas');
  const after = preview.locator('.pane-output canvas');

  // Rasterising is async and starts after the run lands, so poll rather than
  // reading once. `varied` is what makes this worth asserting: the elements are
  // in the DOM from the first frame, painted or not.
  await expect
    .poll(async () => (await readCanvas(before)).varied, { timeout: 45_000 })
    .toBeGreaterThan(MIN_VARIED_PIXELS);
  await expect
    .poll(async () => (await readCanvas(after)).varied, { timeout: 45_000 })
    .toBeGreaterThan(MIN_VARIED_PIXELS);

  const firstPage = await readCanvas(after);
  expect(
    (await readCanvas(before)).hash,
    'the two panes must come from the two different documents, not one wired twice',
  ).not.toBe(firstPage.hash);

  // ---------------------------------------------------------------- paging
  // The fixture is a deliberate two-pager (see scripts/generate-assets.mjs):
  // a duotone JPEG on page 1, a flat poster PNG on page 2. Turning the page has
  // to reach pdf.js again — a cached or hard-wired first page would leave every
  // assertion above green.
  const pager = preview.locator('.pager-count');
  await expect(pager).toHaveText('1 of 2');

  await preview.getByRole('button', { name: 'Next page' }).click();
  await expect(pager).toHaveText('2 of 2');

  // One poll for both conditions, not two. The previous page stays on the
  // canvas while the next one rasterises, and the stage re-keys on the page
  // number in between, so "the pixels changed" on its own can be satisfied by a
  // transient frame. Only "changed *and* still a whole page" is a settled state.
  await expect
    .poll(
      async () => {
        const shot = await readCanvas(after);
        return shot.hash !== firstPage.hash && shot.varied > MIN_VARIED_PIXELS;
      },
      { timeout: 45_000, message: 'page 2 should rasterise to different, non-blank pixels' },
    )
    .toBe(true);

  const dl = page.waitForEvent('download');
  await download.click();
  expect((await dl).suggestedFilename()).toMatch(/\.pdf$/);

  expect(fatal, `fatal console/page errors during PDF conversion:\n${fatal.join('\n')}`).toEqual([]);
});
