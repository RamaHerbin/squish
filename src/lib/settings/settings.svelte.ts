/**
 * Persisted, app-wide preferences — screen 05.
 *
 * Same defensive posture as `state/settings-persistence.ts`, whose approach
 * this mirrors: everything read back from IndexedDB is untrusted input, so
 * every field is rebuilt from {@link DEFAULT_APP_SETTINGS} and only copied
 * across when it exists with the right primitive type (see
 * {@link sanitizeAppSettings}). A corrupted record, a blocked store, or no
 * IndexedDB at all (private browsing, an old browser, this test runner) all
 * degrade to defaults instead of throwing.
 *
 * `idb-keyval`'s `get`/`set` reference the global `indexedDB` as a *default
 * parameter value* — evaluated eagerly, so calling them at all throws
 * synchronously (not a rejected promise) when the global does not exist.
 * {@link createIdbBackedStore} guards with a `typeof indexedDB` check before
 * ever calling into the library, exactly like `state/settings-persistence.ts`
 * does.
 */

import { get as idbGet, set as idbSet } from 'idb-keyval';
import {
  DEFAULT_APP_SETTINGS,
  ENCODER_IDS,
  WORKER_THREADS_RANGE,
  createDefaultAppSettings,
  isEncoderId,
  type AppSettings,
} from '../contracts';

/* -------------------------------------------------------------------------- */
/* Storage seam                                                                */
/* -------------------------------------------------------------------------- */

export const APP_SETTINGS_KEY = 'app-settings';

/** Trailing debounce for writes — dragging the worker-threads slider must not hammer IndexedDB. */
export const APP_SETTINGS_SAVE_DEBOUNCE_MS = 400;

/** The two operations we need. Swap it out in tests; no IndexedDB required. */
export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** In-memory stand-in, used by tests and wherever IndexedDB is unavailable. */
export function createMemoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
  };
}

/**
 * `idb-keyval` against the default database, or an in-memory store when there
 * is no IndexedDB at all. The `typeof indexedDB` check must happen *before*
 * `idbGet`/`idbSet` are ever called — see the module doc comment.
 */
export function createIdbBackedStore(): KeyValueStore {
  if (typeof indexedDB === 'undefined') return createMemoryStore();
  return {
    get: (key) => idbGet(key),
    set: (key, value) => idbSet(key, value),
  };
}

let defaultStore: KeyValueStore | undefined;

function sharedStore(): KeyValueStore {
  defaultStore ??= createIdbBackedStore();
  return defaultStore;
}

/* -------------------------------------------------------------------------- */
/* Sanitising                                                                  */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Clamp to {@link WORKER_THREADS_RANGE} and snap to the nearest step. */
export function clampWorkerThreads(value: number): number {
  const { min, max, step } = WORKER_THREADS_RANGE;
  if (!Number.isFinite(value)) return DEFAULT_APP_SETTINGS.workerThreads;
  const stepped = Math.round(value / step) * step;
  return Math.min(max, Math.max(min, stepped));
}

/**
 * Every encoder a "pick one" control should offer — everything but the
 * `identity` passthrough, which is not a real output format. Matches the
 * editor's own "9 total" hint (`ENCODER_IDS.length - 1`).
 */
export const SELECTABLE_ENCODER_IDS = ENCODER_IDS.filter((id) => id !== 'identity');

/**
 * Rebuild an {@link AppSettings} from untrusted input (IndexedDB, a hand-
 * edited record). Keeps only keys that exist and have the right primitive
 * type; anything else falls back to {@link DEFAULT_APP_SETTINGS}.
 */
export function sanitizeAppSettings(value: unknown): AppSettings {
  const out = createDefaultAppSettings();
  if (!isRecord(value)) return out;

  if (isEncoderId(value['defaultEncoder'])) out.defaultEncoder = value['defaultEncoder'];
  if (typeof value['autoSuggest'] === 'boolean') out.autoSuggest = value['autoSuggest'];
  if (typeof value['keepExif'] === 'boolean') out.keepExif = value['keepExif'];
  if (typeof value['workerThreads'] === 'number') {
    out.workerThreads = clampWorkerThreads(value['workerThreads']);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

export interface AppSettingsStore {
  /** Reactive current value. Read-only — go through the setters below. */
  readonly current: AppSettings;
  /** Resolves once the initial IndexedDB read has settled. */
  readonly ready: Promise<void>;
  setDefaultEncoder(id: AppSettings['defaultEncoder']): void;
  setAutoSuggest(value: boolean): void;
  setKeepExif(value: boolean): void;
  setWorkerThreads(value: number): void;
  /** Back to {@link DEFAULT_APP_SETTINGS}, persisted immediately. */
  reset(): void;
  /** Write any debounced change now. Tests / beforeunload only. */
  flush(): Promise<void>;
}

export interface CreateAppSettingsStoreOptions {
  /** Swap the persistence key/backing store in tests. */
  key?: string;
  store?: KeyValueStore;
  debounceMs?: number;
}

export function createAppSettingsStore(
  options: CreateAppSettingsStoreOptions = {},
): AppSettingsStore {
  const key = options.key ?? APP_SETTINGS_KEY;
  const store = options.store ?? sharedStore();
  const debounceMs = options.debounceMs ?? APP_SETTINGS_SAVE_DEBOUNCE_MS;

  let value = $state<AppSettings>(createDefaultAppSettings());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  function persistNow(): Promise<void> {
    const snapshot = { ...value };
    inFlight = inFlight
      .catch(() => undefined)
      .then(() => store.set(key, snapshot))
      .catch((error: unknown) => {
        console.warn('[pinch] could not save settings', error);
      });
    return inFlight;
  }

  function scheduleSave(): void {
    if (timer !== undefined) clearTimeout(timer);
    if (debounceMs <= 0) {
      void persistNow();
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void persistNow();
    }, debounceMs);
  }

  function patch(next: Partial<AppSettings>): void {
    value = { ...value, ...next };
    scheduleSave();
  }

  const readyPromise = (async () => {
    try {
      const stored = await store.get(key);
      value = sanitizeAppSettings(stored);
    } catch (error) {
      console.warn('[pinch] could not load settings', error);
    }
  })();

  return {
    get current() {
      return value;
    },
    ready: readyPromise,

    setDefaultEncoder(id) {
      patch({ defaultEncoder: id });
    },
    setAutoSuggest(next) {
      patch({ autoSuggest: next });
    },
    setKeepExif(next) {
      patch({ keepExif: next });
    },
    setWorkerThreads(next) {
      patch({ workerThreads: clampWorkerThreads(next) });
    },

    reset() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      value = createDefaultAppSettings();
      void persistNow();
    },

    async flush() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
        await persistNow();
      }
      await inFlight;
    },
  };
}

/** Shared app-wide singleton. Screens should use this rather than constructing their own. */
export const appSettings = createAppSettingsStore();
