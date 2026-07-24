import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_APP_SETTINGS, WORKER_THREADS_RANGE } from '../contracts';
import {
  clampWorkerThreads,
  createAppSettingsStore,
  createMemoryStore,
  sanitizeAppSettings,
  SELECTABLE_ENCODER_IDS,
} from './settings.svelte';

describe('sanitizeAppSettings (pure)', () => {
  it('returns the defaults for garbage input', () => {
    expect(sanitizeAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS);
    expect(sanitizeAppSettings(undefined)).toEqual(DEFAULT_APP_SETTINGS);
    expect(sanitizeAppSettings('nope')).toEqual(DEFAULT_APP_SETTINGS);
    expect(sanitizeAppSettings(42)).toEqual(DEFAULT_APP_SETTINGS);
    expect(sanitizeAppSettings([])).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('copies across only recognised, well-typed keys', () => {
    const result = sanitizeAppSettings({
      defaultEncoder: 'mozjpeg',
      autoSuggest: false,
      keepExif: true,
      workerThreads: 6,
      extraJunk: 'ignored',
    });
    expect(result).toEqual({
      defaultEncoder: 'mozjpeg',
      autoSuggest: false,
      keepExif: true,
      workerThreads: 6,
    });
  });

  it('falls back per-field when a value has the wrong shape', () => {
    const result = sanitizeAppSettings({
      defaultEncoder: 'not-a-real-encoder',
      autoSuggest: 'yes',
      keepExif: 1,
      workerThreads: 'lots',
    });
    expect(result).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('clamps workerThreads into WORKER_THREADS_RANGE', () => {
    expect(sanitizeAppSettings({ workerThreads: -5 }).workerThreads).toBe(
      WORKER_THREADS_RANGE.min,
    );
    expect(sanitizeAppSettings({ workerThreads: 999 }).workerThreads).toBe(
      WORKER_THREADS_RANGE.max,
    );
    expect(sanitizeAppSettings({ workerThreads: NaN }).workerThreads).toBe(
      DEFAULT_APP_SETTINGS.workerThreads,
    );
  });

  it('never produces the identity encoder from an untouched default', () => {
    // Sanity check on the fixture the whole module leans on.
    expect(SELECTABLE_ENCODER_IDS).not.toContain('identity');
    expect(SELECTABLE_ENCODER_IDS.length).toBe(9);
  });
});

describe('clampWorkerThreads (pure)', () => {
  it('rounds to the nearest step and clamps to range bounds', () => {
    expect(clampWorkerThreads(0)).toBe(WORKER_THREADS_RANGE.min);
    expect(clampWorkerThreads(3.6)).toBe(4);
    expect(clampWorkerThreads(100)).toBe(WORKER_THREADS_RANGE.max);
  });
});

describe('createAppSettingsStore', () => {
  it('resolves `ready` with defaults when the store is empty', async () => {
    const settings = createAppSettingsStore({ store: createMemoryStore(), debounceMs: 0 });
    await settings.ready;
    expect(settings.current).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('loads and sanitizes whatever was already in the store', async () => {
    const store = createMemoryStore();
    await store.set('app-settings', { defaultEncoder: 'jxl', workerThreads: 2 });
    const settings = createAppSettingsStore({ store, debounceMs: 0 });
    await settings.ready;
    expect(settings.current.defaultEncoder).toBe('jxl');
    expect(settings.current.workerThreads).toBe(2);
    expect(settings.current.autoSuggest).toBe(DEFAULT_APP_SETTINGS.autoSuggest);
  });

  it('persists setter calls, debounced', async () => {
    vi.useFakeTimers();
    try {
      const store = createMemoryStore();
      const setSpy = vi.spyOn(store, 'set');
      const settings = createAppSettingsStore({ store, debounceMs: 50 });
      await settings.ready;

      settings.setWorkerThreads(8);
      settings.setAutoSuggest(false);
      expect(settings.current.workerThreads).toBe(8);
      expect(settings.current.autoSuggest).toBe(false);
      // Debounced: no write yet.
      expect(setSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60);
      expect(setSpy).toHaveBeenCalledTimes(1);
      const saved = await store.get('app-settings');
      expect(saved).toMatchObject({ workerThreads: 8, autoSuggest: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('flush() writes immediately and settles pending writes', async () => {
    const store = createMemoryStore();
    const settings = createAppSettingsStore({ store, debounceMs: 10_000 });
    await settings.ready;

    settings.setKeepExif(true);
    await settings.flush();

    const saved = await store.get('app-settings');
    expect(saved).toMatchObject({ keepExif: true });
  });

  it('reset() returns to defaults and persists them', async () => {
    const store = createMemoryStore();
    const settings = createAppSettingsStore({ store, debounceMs: 0 });
    await settings.ready;

    settings.setDefaultEncoder('webp');
    settings.reset();
    expect(settings.current).toEqual(DEFAULT_APP_SETTINGS);

    await settings.flush();
    const saved = await store.get('app-settings');
    expect(saved).toEqual(DEFAULT_APP_SETTINGS);
  });
});
