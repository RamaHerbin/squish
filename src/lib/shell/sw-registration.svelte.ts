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
 * The page reload that follows the handover is ours too — see `reload()` for
 * why the plugin's own one cannot be trusted.
 *
 * Only reachable inside a real Vite build with the vite-plugin-pwa plugin
 * active — `virtual:pwa-register/svelte` does not resolve under plain
 * `vitest run`, so this file is intentionally not covered by
 * `shell.test.ts`.
 *
 * Skipped entirely in the macOS app. WKWebView refuses to register a service
 * worker on a custom scheme, so `useRegisterSW()` on `tauri://localhost` can
 * only ever produce a console error, and an "update available, reload" prompt
 * is meaningless in a native app that ships its assets in the bundle. The
 * guard is here rather than at the `UpdateToast` mount point because importing
 * this module is what registers: the singleton below constructs at module
 * evaluation, long before anything renders.
 */

import { useRegisterSW } from 'virtual:pwa-register/svelte';

import { isTauri } from '../platform';

/**
 * How long `reload()` waits for the incoming worker to take control before
 * reloading anyway. Generous: activation only has to run `sw.ts`'s precache
 * install/activate handlers, which is milliseconds in practice, and firing
 * early would just burn a reload on the old version.
 */
const HANDOVER_TIMEOUT_MS = 5_000;

class ServiceWorkerStatus {
  /** A new version has been fetched and is waiting to take over. */
  needRefresh = $state(false);
  /** Precaching finished; the app now works offline. */
  offlineReady = $state(false);

  #activate: (reloadPage?: boolean) => Promise<void>;
  #registration: ServiceWorkerRegistration | undefined;
  /** A `reload()` is in flight — ignore further clicks. */
  #reloading = false;
  /** `window.location.reload()` has been called — never call it twice. */
  #reloadTriggered = false;

  constructor() {
    if (isTauri()) {
      // Both flags stay false, so `UpdateToast` renders nothing at all.
      this.#activate = async () => {};
      return;
    }

    const { needRefresh, offlineReady, updateServiceWorker } = useRegisterSW({
      onRegisteredSW: (_swScriptUrl, registration) => {
        this.#registration = registration;
      },
      // Takes the plugin's own `window.location.reload()` out of the picture
      // (see `reload()`): its trigger is unreliable, and when it does fire it
      // would otherwise race ours.
      onNeedReload: () => this.#reloadPage(),
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

  /**
   * Activate the waiting worker and reload once it takes control.
   *
   * The reload is driven here, off `controllerchange`, rather than left to
   * vite-plugin-pwa. The plugin reloads from its own `controlling` listener
   * but only when workbox flags that event as `isUpdate` — and `isUpdate` is
   * `Boolean(navigator.serviceWorker.controller)` sampled once, at
   * registration time. Any load that started out uncontrolled samples `false`
   * and stays that way for the life of the page: a first-ever visit whose tab
   * is still open when the next version ships, or a hard reload (which
   * bypasses the worker for the navigation) with a second tab holding the old
   * worker alive. In those cases clicking Reload did activate the new worker
   * and then never reloaded — a dead-looking button with the toast still up,
   * which is exactly the bug this replaces.
   */
  async reload(): Promise<void> {
    if (this.#reloading) return;
    this.#reloading = true;

    // Nothing waiting to hand over to — an update that resolved in another
    // tab, or a worker that already took control. A plain reload is both
    // correct here and, more to the point, not nothing.
    if (!this.#registration?.waiting) {
      this.#reloadPage();
      return;
    }

    navigator.serviceWorker.addEventListener('controllerchange', this.#reloadPage, { once: true });
    // Belt and braces: if the handover never lands, reload anyway rather than
    // leave the button looking broken a second time.
    window.setTimeout(this.#reloadPage, HANDOVER_TIMEOUT_MS);

    await this.#activate(true);
  }

  #reloadPage = (): void => {
    if (this.#reloadTriggered) return;
    this.#reloadTriggered = true;
    window.location.reload();
  };

  dismissNeedRefresh(): void {
    this.needRefresh = false;
  }

  dismissOfflineReady(): void {
    this.offlineReady = false;
  }
}

export const swStatus = new ServiceWorkerStatus();
