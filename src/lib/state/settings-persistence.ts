/**
 * Persisting each side's settings between visits, via `idb-keyval`.
 *
 * Squoosh stashes side settings in `localStorage` as raw `JSON.parse` output and
 * feeds them straight back into the encoder. We do not: anything that has been
 * outside this tab is untrusted input, and encoder options end up as arguments
 * to wasm. Everything read back goes through {@link sanitizeSideSettings},
 * which rebuilds the value from the contract defaults and copies across only
 * keys that exist and have the right primitive type. A corrupted or hand-edited
 * record degrades to defaults instead of exploding.
 *
 * IndexedDB rather than `localStorage` because writes are async (no jank on a
 * slider drag) and because it survives Safari's storage eviction rules better.
 * Every operation is best-effort: private browsing, blocked storage, or a failed
 * upgrade must never break the editor.
 */

import { del, get, set } from 'idb-keyval';
import {
  DEFAULT_ENCODER_OPTIONS,
  RESIZE_METHODS,
  createDefaultResizeState,
  createDefaultSideSettings,
  createSideSettings,
  isSideSettings,
} from '../contracts';
import type {
  EncoderId,
  EncoderOptionsMap,
  FitMethod,
  ProcessorState,
  ResizeMethod,
  ResizeState,
  SideIndex,
  SideSettings,
} from '../contracts';
import type { SettingsPersistence } from './engine';

/* -------------------------------------------------------------------------- */
/* Keys                                                                        */
/* -------------------------------------------------------------------------- */

export const SIDE_SETTINGS_KEY_PREFIX = 'squish:side-settings:';

export function sideSettingsKey(side: SideIndex): string {
  return `${SIDE_SETTINGS_KEY_PREFIX}${side}`;
}

/** Trailing debounce for writes; a slider drag must not hammer IndexedDB. */
export const SETTINGS_SAVE_DEBOUNCE_MS = 500;

/* -------------------------------------------------------------------------- */
/* Storage seam                                                                */
/* -------------------------------------------------------------------------- */

/** The three operations we need. Swap it out in tests; no IndexedDB required. */
export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
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
    async del(key) {
      map.delete(key);
    },
  };
}

/**
 * `idb-keyval` against the default database, or an in-memory store when there is
 * no IndexedDB at all (node, some embedded webviews, hardened privacy modes).
 */
export function createIdbStore(): KeyValueStore {
  if (typeof indexedDB === 'undefined') return createMemoryStore();
  return {
    get: (key) => get(key),
    set: (key, value) => set(key, value),
    del: (key) => del(key),
  };
}

let defaultStore: KeyValueStore | undefined;

function sharedStore(): KeyValueStore {
  defaultStore ??= createIdbStore();
  return defaultStore;
}

/* -------------------------------------------------------------------------- */
/* Sanitising                                                                  */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Keep only keys the encoder actually declares, with the same primitive type as
 * the default. Unknown keys are dropped, wrong types fall back to the default,
 * and `NaN`/`Infinity` never reach a codec.
 */
function sanitizeEncoderOptions<K extends EncoderId>(
  id: K,
  raw: Record<string, unknown>,
): Partial<EncoderOptionsMap[K]> {
  const defaults = DEFAULT_ENCODER_OPTIONS[id] as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = raw[key];
    if (typeof value !== typeof fallback) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    out[key] = value;
  }
  return out as Partial<EncoderOptionsMap[K]>;
}

function isResizeMethod(value: unknown): value is ResizeMethod {
  return typeof value === 'string' && (RESIZE_METHODS as readonly string[]).includes(value);
}

function sanitizeResizeState(raw: Record<string, unknown>): ResizeState {
  const resize = createDefaultResizeState();
  if (typeof raw['enabled'] === 'boolean') resize.enabled = raw['enabled'];
  if (typeof raw['width'] === 'number' && Number.isFinite(raw['width'])) {
    resize.width = Math.max(1, Math.round(raw['width']));
  }
  if (typeof raw['height'] === 'number' && Number.isFinite(raw['height'])) {
    resize.height = Math.max(1, Math.round(raw['height']));
  }
  if (isResizeMethod(raw['method'])) resize.method = raw['method'];
  if (typeof raw['premultiply'] === 'boolean') resize.premultiply = raw['premultiply'];
  if (typeof raw['linearRGB'] === 'boolean') resize.linearRGB = raw['linearRGB'];
  if (raw['fitMethod'] === 'stretch' || raw['fitMethod'] === 'contain') {
    resize.fitMethod = raw['fitMethod'] as FitMethod;
  }
  return resize;
}

/**
 * Rebuild through {@link createSideSettings} per encoder id. The switch exists
 * so each branch has a literal `K` — that is what keeps `encoderOptions`
 * correlated with `encoderId` instead of collapsing to the union, and it is why
 * no cast is needed anywhere in this file.
 */
function buildSideSettings(
  id: EncoderId,
  options: Record<string, unknown>,
  processorState: ProcessorState,
): SideSettings {
  switch (id) {
    case 'avif':
      return createSideSettings('avif', sanitizeEncoderOptions('avif', options), processorState);
    case 'jxl':
      return createSideSettings('jxl', sanitizeEncoderOptions('jxl', options), processorState);
    case 'webp':
      return createSideSettings('webp', sanitizeEncoderOptions('webp', options), processorState);
    case 'mozjpeg':
      return createSideSettings(
        'mozjpeg',
        sanitizeEncoderOptions('mozjpeg', options),
        processorState,
      );
    case 'oxipng':
      return createSideSettings(
        'oxipng',
        sanitizeEncoderOptions('oxipng', options),
        processorState,
      );
    case 'qoi':
      return createSideSettings('qoi', undefined, processorState);
    case 'browser-png':
      return createSideSettings('browser-png', undefined, processorState);
    case 'browser-jpeg':
      return createSideSettings(
        'browser-jpeg',
        sanitizeEncoderOptions('browser-jpeg', options),
        processorState,
      );
    case 'browser-webp':
      return createSideSettings(
        'browser-webp',
        sanitizeEncoderOptions('browser-webp', options),
        processorState,
      );
    case 'identity':
      return createSideSettings('identity', undefined, processorState);
  }
}

/**
 * Validate and rebuild a `SideSettings` from untrusted input (IndexedDB, a
 * shared `?p=` token, a pasted JSON blob). Returns `undefined` when the shape is
 * not recognisable at all.
 */
export function sanitizeSideSettings(value: unknown): SideSettings | undefined {
  if (!isSideSettings(value)) return undefined;

  const raw = value as unknown as Record<string, unknown>;
  const rawProcessor = isRecord(raw['processorState']) ? raw['processorState'] : {};
  const rawResize = isRecord(rawProcessor['resize']) ? rawProcessor['resize'] : {};
  const processorState: ProcessorState = { resize: sanitizeResizeState(rawResize) };
  const rawOptions = isRecord(raw['encoderOptions']) ? raw['encoderOptions'] : {};

  return buildSideSettings(value.encoderId, rawOptions, processorState);
}

/* -------------------------------------------------------------------------- */
/* Load / save                                                                 */
/* -------------------------------------------------------------------------- */

function warnOnce(message: string, error: unknown): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[squish] ${message}`, error);
}
const warned = new Set<string>();

export async function loadSideSettings(
  side: SideIndex,
  store: KeyValueStore = sharedStore(),
): Promise<SideSettings | undefined> {
  try {
    return sanitizeSideSettings(await store.get(sideSettingsKey(side)));
  } catch (error) {
    warnOnce('could not read saved settings', error);
    return undefined;
  }
}

/** Saved settings for both sides, falling back to the contract defaults. */
export async function loadAllSideSettings(
  store: KeyValueStore = sharedStore(),
): Promise<[SideSettings, SideSettings]> {
  const [left, right] = await Promise.all([
    loadSideSettings(0, store),
    loadSideSettings(1, store),
  ]);
  return [left ?? createDefaultSideSettings(0), right ?? createDefaultSideSettings(1)];
}

export async function saveSideSettings(
  side: SideIndex,
  settings: SideSettings,
  store: KeyValueStore = sharedStore(),
): Promise<void> {
  try {
    // Structured-clone safe: sanitize returns plain objects, never a $state proxy.
    await store.set(sideSettingsKey(side), sanitizeSideSettings(settings) ?? settings);
  } catch (error) {
    warnOnce('could not save settings', error);
  }
}

export async function clearSideSettings(store: KeyValueStore = sharedStore()): Promise<void> {
  try {
    await Promise.all([store.del(sideSettingsKey(0)), store.del(sideSettingsKey(1))]);
  } catch (error) {
    warnOnce('could not clear settings', error);
  }
}

/* -------------------------------------------------------------------------- */
/* Debounced handle for the job engine                                         */
/* -------------------------------------------------------------------------- */

export interface SettingsPersistenceHandle extends SettingsPersistence {
  load(): Promise<[SideSettings, SideSettings]>;
  /** Write any debounced changes now. */
  flush(): Promise<void>;
  clear(): Promise<void>;
  /** Drop pending writes and stop. */
  dispose(): void;
}

export interface SettingsPersistenceOptions {
  store?: KeyValueStore;
  /** `0` writes synchronously-ish (still async, just not debounced). */
  debounceMs?: number;
}

/**
 * The object handed to the job engine as `persistence`. `save()` is
 * fire-and-forget and debounced, so dragging a quality slider costs one write,
 * not two hundred.
 */
export function createSettingsPersistence(
  options: SettingsPersistenceOptions = {},
): SettingsPersistenceHandle {
  const store = options.store ?? sharedStore();
  const debounceMs = options.debounceMs ?? SETTINGS_SAVE_DEBOUNCE_MS;

  const pending = new Map<SideIndex, SideSettings>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let disposed = false;

  const writePending = (): Promise<void> => {
    if (pending.size === 0) return Promise.resolve();
    const batch = [...pending.entries()];
    pending.clear();
    inFlight = inFlight
      .catch(() => undefined)
      .then(async () => {
        for (const [side, settings] of batch) await saveSideSettings(side, settings, store);
      });
    return inFlight;
  };

  return {
    save(side, settings) {
      if (disposed) return;
      pending.set(side, settings);
      if (debounceMs <= 0) {
        void writePending();
        return;
      }
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void writePending();
      }, debounceMs);
    },
    load: () => loadAllSideSettings(store),
    async flush() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      await writePending();
      await inFlight;
    },
    async clear() {
      pending.clear();
      await clearSideSettings(store);
    },
    dispose() {
      disposed = true;
      pending.clear();
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
