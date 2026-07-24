/**
 * Captures the browser's `beforeinstallprompt` event and exposes it as
 * runes state, so any component (Header's install button, an IntroView
 * nudge, …) can offer "Install app" without racing to attach its own
 * listener — the event fires once per page load and must be captured
 * immediately, so this module does it eagerly on import.
 *
 * Singleton: `import { installPrompt } from './install-prompt.svelte';
 * installPrompt.available` / `await installPrompt.promptInstall()`.
 */

/** Minimal shape of the non-standard `BeforeInstallPromptEvent`. */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

function isBeforeInstallPromptEvent(event: Event): event is BeforeInstallPromptEvent {
  return typeof (event as Partial<BeforeInstallPromptEvent>).prompt === 'function';
}

class InstallPromptStore {
  #deferred = $state<BeforeInstallPromptEvent | undefined>(undefined);
  /** True once `appinstalled` has fired, or the app is already running standalone. */
  installed = $state(false);

  /** True when there is a captured prompt ready to show, and it isn't installed yet. */
  available = $derived(this.#deferred !== undefined && !this.installed);

  constructor() {
    if (typeof window === 'undefined') return;

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      if (isBeforeInstallPromptEvent(event)) this.#deferred = event;
    });

    window.addEventListener('appinstalled', () => {
      this.installed = true;
      this.#deferred = undefined;
    });

    if (window.matchMedia?.('(display-mode: standalone)').matches) {
      this.installed = true;
    }
  }

  /**
   * Show the captured install prompt. A no-op returning `'unavailable'` if
   * nothing was captured (no browser support, or already used/dismissed —
   * the event can only be consumed once).
   */
  async promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    const event = this.#deferred;
    if (!event) return 'unavailable';
    this.#deferred = undefined;
    await event.prompt();
    const choice = await event.userChoice;
    return choice.outcome;
  }
}

export const installPrompt = new InstallPromptStore();
