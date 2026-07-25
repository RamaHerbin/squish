/**
 * Theme store: follows `prefers-color-scheme` by default, with a manual
 * toggle that pins an explicit choice to `localStorage`.
 *
 * Applies the resolved theme as `data-theme` on `<html>`.
 *
 * NOTE: inert since the "Pinch — Editorial" redesign. `src/app.css` declares
 * `color-scheme: light` app-wide and ships no dark variant, so nothing reads
 * `data-theme` any more. Kept because the store is pure, tested, and the one
 * place a future dark theme would hook back in — no UI should offer a toggle.
 *
 * Singleton: `import { theme } from './theme.svelte'; theme.current` /
 * `theme.toggle()`. Reading `theme.current` inside a component or
 * `$derived` subscribes to it, same as any other runes state.
 */

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'squish:theme';

/** Pure: what `localStorage` currently holds, ignoring anything malformed. */
export function readStoredTheme(): Theme | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === 'light' || raw === 'dark' ? raw : undefined;
}

/** Pure: the OS/browser preference. Defaults to dark when it can't be read. */
export function systemTheme(): Theme {
  if (typeof matchMedia !== 'function') return 'dark';
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

class ThemeStore {
  #explicit = $state<Theme | undefined>(readStoredTheme());
  #system = $state<Theme>(systemTheme());

  /** Resolved theme actually in effect right now. */
  current = $derived(this.#explicit ?? this.#system);
  /** True once the user has toggled away from following the OS preference. */
  isExplicit = $derived(this.#explicit !== undefined);

  constructor() {
    this.#applyToDocument();
    if (typeof matchMedia === 'function') {
      matchMedia('(prefers-color-scheme: light)').addEventListener('change', (event) => {
        this.#system = event.matches ? 'light' : 'dark';
        this.#applyToDocument();
      });
    }
  }

  #applyToDocument(): void {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-theme', this.current);
  }

  /** Flip the resolved theme and pin the result as an explicit choice. */
  toggle(): void {
    this.#explicit = this.current === 'dark' ? 'light' : 'dark';
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, this.#explicit);
    this.#applyToDocument();
  }

  /** Drop any pinned choice and go back to following the OS preference. */
  useSystem(): void {
    this.#explicit = undefined;
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
    this.#applyToDocument();
  }
}

export const theme = new ThemeStore();
