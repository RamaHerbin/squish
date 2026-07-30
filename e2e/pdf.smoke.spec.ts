import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/**
 * PDF conversion smoke test.
 *
 * Loads a real PDF through the home file picker, lets the app route it to the
 * PDF view, waits for the embedded-image analysis to populate, runs one
 * compress pass, and downloads the result. This is the regression net for "a
 * merged PR silently broke the PDF pipeline" — most importantly the pdf.js /
 * pdf-lib decode-and-rewrite path, which unit tests can't reach because they
 * never run the real wasm codecs or drive the actual view in a browser.
 *
 * Runs against `vite preview` (see playwright.config.ts), which sends COOP/COEP,
 * so `crossOriginIsolated` is true and jSquash loads its threaded builds.
 */

const FIXTURE = fileURLToPath(new URL('../public/demo/demo-report.pdf', import.meta.url));

/** Console/page errors that mean the pipeline actually broke (not incidental noise). */
const FATAL = [/worker sent an error/i, /reading 'id'/, /WorkerLoadError/, /WorkerTimeoutError/, /pthread/i];

test('converts a PDF end to end', async ({ page }) => {
  const fatal: string[] = [];
  const record = (text: string) => {
    if (FATAL.some((re) => re.test(text))) fatal.push(text);
  };
  page.on('console', (msg) => {
    if (msg.type() === 'error') record(msg.text());
  });
  page.on('pageerror', (err) => record(String(err)));

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

  // Do not toggle the SSIM measure checkbox — keep the run fast and deterministic.
  await trigger.click();

  await expect(download).toBeEnabled({ timeout: 45_000 });
  await expect(figure).toHaveText(/\d/, { timeout: 45_000 });

  const dl = page.waitForEvent('download');
  await download.click();
  expect((await dl).suggestedFilename()).toMatch(/\.pdf$/);

  expect(fatal, `fatal console/page errors during PDF conversion:\n${fatal.join('\n')}`).toEqual([]);
});
