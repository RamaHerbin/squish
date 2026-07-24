/// <reference types="vite-plugin-pwa/svelte" />

/**
 * Service-worker registration + update lifecycle, as runes state.
 *
 * Wraps vite-plugin-pwa's `virtual:pwa-register/svelte` — which exposes
 * `svelte/store` writables — into a `$state`-backed singleton so nothing
 * downstream needs to touch `svelte/store`. Pair with `UpdateToast.svelte`.
 *
 * IMPORTANT: importing this module is what triggers registration (it calls
 * `useRegisterSW()` at construction). If `UpdateToast.svelte` — the only
 * thing that imports it — is never mounted, the service worker never
 * registers at all. See integration notes.
 *
 * `registerType: 'prompt'` (vite.config.ts) means a waiting worker never
 * takes over on its own; `reload()` is what actually activates it. Because
 * the PWA strategy is `injectManifest` (see `./sw.ts`), the "skip waiting on
 * demand" behaviour that `generateSW` would inject automatically is instead
 * hand-rolled: `reload()` posts the standard `{ type: 'SKIP_WAITING' }`
 * message (via `updateServiceWorker`), which `sw.ts`'s own `message`
 * listener answers by calling `self.skipWaiting()`.
 *
 * Only reachable inside a real Vite build with the vite-plugin-pwa plugin
 * active — `virtual:pwa-register/svelte` does not resolve under plain
 * `vitest run`, so this file is intentionally not covered by
 * `shell.test.ts`.
 */

import { useRegisterSW } from 'virtual:pwa-register/svelte';

class ServiceWorkerStatus {
  /** A new version has been fetched and is waiting to take over. */
  needRefresh = $state(false);
  /** Precaching finished; the app now works offline. */
  offlineReady = $state(false);

  #activate: (reloadPage?: boolean) => Promise<void>;

  constructor() {
    const { needRefresh, offlineReady, updateServiceWorker } = useRegisterSW({
      onRegisterError: (error: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[squish] service worker registration failed', error);
      },
    });
    this.#activate = updateServiceWorker;
    needRefresh.subscribe((value) => {
      this.needRefresh = value;
    });
    offlineReady.subscribe((value) => {
      this.offlineReady = value;
    });
  }

  /** Activate the waiting worker and reload once it takes control. */
  async reload(): Promise<void> {
    await this.#activate(true);
  }

  dismissNeedRefresh(): void {
    this.needRefresh = false;
  }

  dismissOfflineReady(): void {
    this.offlineReady = false;
  }
}

export const swStatus = new ServiceWorkerStatus();
