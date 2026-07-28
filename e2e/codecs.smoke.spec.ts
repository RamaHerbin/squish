import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

/**
 * Codec conversion smoke test.
 *
 * Loads a real JPEG, lets the app auto-encode (there is no separate "convert"
 * button — selecting a file starts the pipeline), and asserts a real output
 * lands for every core wasm codec. This is the regression net for "a merged PR
 * silently broke conversion" — most importantly the threaded-AVIF pthread-worker
 * failure, which unit tests can't reach because they never run the wasm codecs
 * in a cross-origin-isolated browser.
 *
 * Runs against `vite preview` (see playwright.config.ts), which sends COOP/COEP,
 * so `crossOriginIsolated` is true and jSquash loads its threaded builds — the
 * ones that break.
 */

const FIXTURE = fileURLToPath(new URL('../public/demo/demo-gradient.jpg', import.meta.url));

/** Every core wasm codec, exercised by selecting it. AVIF first — the one that
 *  broke before. The on-load default (MozJPEG) is covered separately below. */
const WASM_CODECS = ['AVIF', 'JPEG XL', 'WebP', 'MozJPEG', 'OxiPNG'] as const;

/** Console/page errors that mean conversion actually broke (not incidental noise). */
const FATAL = [/worker sent an error/i, /reading 'id'/, /WorkerLoadError/, /WorkerTimeoutError/, /pthread/i];

test('converts a JPEG with every core wasm codec', async ({ page }) => {
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

  // Load a real JPEG into the hidden home file input; encoding starts on its own.
  await page.locator('input.sr-only[type="file"]').setInputFiles(FIXTURE);

  const trigger = page.locator('button[aria-label^="Encoder:"]');
  const download = page.locator('button.download');
  const figure = page.locator('.card-output .figure');

  // The on-load default encoder produced an output (whichever it is).
  await expect(download).toBeEnabled({ timeout: 45_000 });
  await expect(figure).toHaveText(/\d/, { timeout: 45_000 });
  await expect(page.locator('canvas[aria-label="Output"]')).toBeVisible();

  for (const codec of WASM_CODECS) {
    await expectEncoded(page, codec, { trigger, download, figure });
  }

  expect(fatal, `fatal console/page errors during conversion:\n${fatal.join('\n')}`).toEqual([]);
});

type Signals = {
  trigger: ReturnType<Page['locator']>;
  download: ReturnType<Page['locator']>;
  figure: ReturnType<Page['locator']>;
};

/** Select `codec` and wait for its re-encode to actually land. */
async function expectEncoded(page: Page, codec: string, s: Signals): Promise<void> {
  const before = ((await s.figure.textContent()) ?? '').trim();

  await s.trigger.click();
  // A row's accessible name is label + note chip, so match the exact `.row-name`
  // text (which also disambiguates "WebP" from "Browser WebP", etc.).
  const row = page
    .getByRole('menuitemradio')
    .filter({ has: page.getByText(codec, { exact: true }) });
  await row.click();
  await expect(s.trigger).toHaveAttribute('aria-label', new RegExp(`Encoder:\\s*${codec}`));

  // A different codec on this photo yields a different output size, so the
  // figure changing is proof the new encode ran (not the previous result still
  // on screen). The digit + enabled checks then gate on the final, settled
  // state rather than a mid-encode blank.
  await expect(s.figure).not.toHaveText(before, { timeout: 45_000 });
  await expect(s.figure).toHaveText(/\d/, { timeout: 45_000 });
  await expect(s.download).toBeEnabled({ timeout: 45_000 });
}
