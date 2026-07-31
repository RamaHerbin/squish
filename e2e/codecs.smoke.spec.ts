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
 *
 * "An output landed" is deliberately not the whole test. Two recovery paths can
 * produce a perfectly good file from a broken codec: the browser-encoder
 * fallback (caught by the `browser encoder` meta assertion) and the bridge's
 * silent single-threaded retry (caught by the thread-pool assertions at the
 * end). Both have to be closed or the suite goes green on a degraded app.
 */

const FIXTURE = fileURLToPath(new URL('../public/demo/demo-gradient.jpg', import.meta.url));

/** Every core wasm codec, exercised by selecting it. AVIF first — the one that
 *  broke before. The on-load default (MozJPEG) is covered separately below. */
const WASM_CODECS = ['AVIF', 'JPEG XL', 'WebP', 'MozJPEG', 'OxiPNG'] as const;

/** Console/page errors that mean conversion actually broke (not incidental noise). */
const FATAL = [/worker sent an error/i, /reading 'id'/, /WorkerLoadError/, /WorkerTimeoutError/, /pthread/i];

/**
 * The three threaded codecs, and the script only their *threaded* build spawns.
 *
 * jSquash chooses between the `_mt` and plain builds from `SharedArrayBuffer`
 * alone, at first init, and never revisits it — so the presence of a thread-pool
 * bootstrap is decisive proof of which build was instantiated.
 * `avif_enc_mt.worker` / `jxl_enc_mt_simd.worker` are emscripten's pthread
 * bootstrap; `workerHelpers.worker` is wasm-bindgen-rayon's, shipped only in
 * OxiPNG's `pkg-parallel`. The single-threaded builds spawn nothing at all.
 *
 * WebP and MozJPEG ship no threaded build, so there is nothing to check for them
 * — which is also why they kept working in production while these three died.
 */
const THREAD_POOL_SCRIPTS: readonly (readonly [codec: string, script: RegExp])[] = [
  ['AVIF', /\/avif_enc_mt\.worker-/],
  ['JPEG XL', /\/jxl_enc_mt(_simd)?\.worker-/],
  ['OxiPNG', /\/workerHelpers\.worker-/],
];

test('converts a JPEG with every core wasm codec', async ({ page }) => {
  const fatal: string[] = [];
  const record = (text: string) => {
    if (FATAL.some((re) => re.test(text))) fatal.push(text);
  };
  page.on('console', (msg) => {
    if (msg.type() === 'error') record(msg.text());
  });
  page.on('pageerror', (err) => record(String(err)));

  // Every script the page pulls in, however it pulls it in. Nested pthread
  // workers surface on both channels in Chromium but not dependably on the same
  // one — wasm-bindgen-rayon's helper only ever showed up as a worker, never as
  // a request — so watch both and match the union.
  const observed: string[] = [];
  page.on('worker', (worker) => observed.push(worker.url()));
  page.on('request', (request) => observed.push(request.url()));

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
  const meta = page.locator('.card-output .meta');

  // The on-load default encoder produced an output (whichever it is)…
  await expect(download).toBeEnabled({ timeout: 45_000 });
  await expect(figure).toHaveText(/\d/, { timeout: 45_000 });
  await expect(page.locator('canvas[aria-label="Output"]')).toBeVisible();
  // …and it came from the real wasm codec, not the browser fallback (see below).
  await expect(meta).not.toContainText('browser encoder');

  for (const codec of WASM_CODECS) {
    await expectEncoded(page, codec, { trigger, download, figure, meta });
  }

  expect(fatal, `fatal console/page errors during conversion:\n${fatal.join('\n')}`).toEqual([]);

  // Everything above passes on a quietly degraded app. When a worker fails to
  // load, `bridge.ts` latches threads off and silently re-runs the call on a
  // codec worker respawned with `?nothreads=1`; that worker deletes
  // `SharedArrayBuffer` so jSquash selects the single-threaded builds. Output
  // still lands, from the real wasm codec, several times slower — no error, no
  // `browser encoder` tag, nothing the assertions above can see. Which means the
  // isolation check at the top now only proves threads were *available*. Prove
  // they were used.

  // `nothreads` is `SINGLE_THREADED_PARAM` in src/lib/codecs/capabilities.ts,
  // spelled out rather than imported so the suite does not reach past a
  // feature's `index.ts` for a constant it does not export.
  const degraded = observed.filter((url) => url.includes('nothreads=1'));
  expect(
    degraded,
    `the bridge latched single-threaded mode — a worker died:\n${degraded.join('\n')}`,
  ).toEqual([]);

  for (const [codec, script] of THREAD_POOL_SCRIPTS) {
    expect(
      observed.some((url) => script.test(url)),
      `${codec} started no wasm thread pool (nothing matching ${script}) — it ran on the ` +
        'single-threaded build, so the threaded path this suite exists to guard was never taken',
    ).toBe(true);
  }
});

type Signals = {
  trigger: ReturnType<Page['locator']>;
  download: ReturnType<Page['locator']>;
  figure: ReturnType<Page['locator']>;
  meta: ReturnType<Page['locator']>;
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

  // Crucial: WebP/MozJPEG/OxiPNG have a browser-encoder fallback that `runEncode`
  // uses transparently when the wasm worker fails (the caught rejection never
  // reaches the console listeners). The output meta is tagged `browser encoder`
  // in that case — so a settled, resized output alone would let a broken wasm
  // codec pass. Assert the real codec produced it. (AVIF/JXL/QOI have no
  // fallback and would surface a fatal console error instead.)
  await expect(s.meta).not.toContainText('browser encoder', { timeout: 45_000 });
}
