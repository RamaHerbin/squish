import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config for the codec smoke test.
 *
 * The suite drives the real app in a headless Chromium against `vite preview`,
 * NOT the dev server: preview serves the production build and — crucially — the
 * `crossOriginIsolation()` plugin sets COOP/COEP there too, so the browser is
 * cross-origin-isolated, `SharedArrayBuffer` exists, and jSquash loads its
 * *threaded* codec builds. That is the path that has broken before (the AVIF
 * pthread-worker failure), and the only way a browser test can catch it.
 *
 * `webServer` builds then serves on a pinned port so the run is self-contained:
 * `npm run test:e2e` needs nothing already running.
 */
const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  timeout: 180_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
