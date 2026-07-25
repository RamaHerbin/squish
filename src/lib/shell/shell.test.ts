// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hasShareTargetMarker, stripShareTargetMarker } from './share-target';

/* -------------------------------------------------------------------------- */
/* share-target.ts — pure URL-marker helpers                                  */
/* -------------------------------------------------------------------------- */

describe('share-target URL helpers', () => {
  it('detects the marker sw.ts redirects to after a share', () => {
    expect(hasShareTargetMarker('?share-target')).toBe(true);
    expect(hasShareTargetMarker('?foo=bar&share-target')).toBe(true);
    expect(hasShareTargetMarker('?foo=bar')).toBe(false);
    expect(hasShareTargetMarker('')).toBe(false);
  });

  it('strips only the marker, keeping any other params', () => {
    expect(stripShareTargetMarker('?share-target')).toBe('');
    expect(stripShareTargetMarker('?share-target&foo=bar')).toBe('?foo=bar');
    expect(stripShareTargetMarker('?foo=bar')).toBe('?foo=bar');
    expect(stripShareTargetMarker('')).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* theme.svelte.ts                                                            */
/* -------------------------------------------------------------------------- */
//
// `theme` is an eagerly-constructed singleton (side effects on import), so
// each case resets the module registry and dynamically re-imports it to get
// a fresh instance under controlled starting conditions.

describe('theme store', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    vi.resetModules();
  });

  it('defaults to dark with no stored choice (jsdom has no matchMedia)', async () => {
    const { theme } = await import('./theme.svelte');
    expect(theme.current).toBe('dark');
    expect(theme.isExplicit).toBe(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('toggle flips the theme, pins it as explicit, and persists it', async () => {
    const { theme } = await import('./theme.svelte');

    theme.toggle();
    expect(theme.current).toBe('light');
    expect(theme.isExplicit).toBe(true);
    expect(localStorage.getItem('squish:theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    theme.toggle();
    expect(theme.current).toBe('dark');
    expect(localStorage.getItem('squish:theme')).toBe('dark');
  });

  it('picks up a previously stored explicit choice on load', async () => {
    localStorage.setItem('squish:theme', 'light');
    const { theme, readStoredTheme } = await import('./theme.svelte');

    expect(readStoredTheme()).toBe('light');
    expect(theme.current).toBe('light');
    expect(theme.isExplicit).toBe(true);
  });

  it('ignores a malformed stored value', async () => {
    localStorage.setItem('squish:theme', 'solarized');
    const { theme } = await import('./theme.svelte');

    expect(theme.isExplicit).toBe(false);
    expect(theme.current).toBe('dark');
  });

  it('useSystem clears the pinned choice and reverts to the OS default', async () => {
    localStorage.setItem('squish:theme', 'light');
    const { theme } = await import('./theme.svelte');
    expect(theme.isExplicit).toBe(true);

    theme.useSystem();
    expect(theme.isExplicit).toBe(false);
    expect(theme.current).toBe('dark');
    expect(localStorage.getItem('squish:theme')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* install-prompt.svelte.ts                                                   */
/* -------------------------------------------------------------------------- */

function dispatchBeforeInstallPrompt(outcome: 'accepted' | 'dismissed' = 'accepted'): void {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  };
  event.prompt = vi.fn().mockResolvedValue(undefined);
  event.userChoice = Promise.resolve({ outcome, platform: 'web' });
  window.dispatchEvent(event);
}

describe('install prompt store', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('is unavailable until a beforeinstallprompt event is captured', async () => {
    const { installPrompt } = await import('./install-prompt.svelte');
    expect(installPrompt.available).toBe(false);

    dispatchBeforeInstallPrompt();
    expect(installPrompt.available).toBe(true);
  });

  it('promptInstall resolves the captured event and consumes it', async () => {
    const { installPrompt } = await import('./install-prompt.svelte');
    dispatchBeforeInstallPrompt('accepted');

    const outcome = await installPrompt.promptInstall();
    expect(outcome).toBe('accepted');
    expect(installPrompt.available).toBe(false);
  });

  it('promptInstall resolves "unavailable" when nothing was captured', async () => {
    const { installPrompt } = await import('./install-prompt.svelte');
    const outcome = await installPrompt.promptInstall();
    expect(outcome).toBe('unavailable');
  });

  it('appinstalled marks installed and clears availability', async () => {
    const { installPrompt } = await import('./install-prompt.svelte');
    dispatchBeforeInstallPrompt();
    expect(installPrompt.available).toBe(true);

    window.dispatchEvent(new Event('appinstalled'));
    expect(installPrompt.installed).toBe(true);
    expect(installPrompt.available).toBe(false);
  });
});
