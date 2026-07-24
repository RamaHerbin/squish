/**
 * Reactive `PresetLibrary` backed by idb-keyval.
 *
 * `presets` is `$state`-backed, so any component reading `library.presets`
 * re-renders on every CRUD op. `ready` resolves once the initial
 * IndexedDB read — plus first-run built-in seeding — has settled; until
 * then `presets` is simply `[]`.
 */

import {
  clear as idbClear,
  createStore,
  del as idbDel,
  entries as idbEntries,
  get as idbGet,
  set as idbSet,
  setMany as idbSetMany,
  type UseStore,
} from 'idb-keyval';

import {
  PRESET_VERSION,
  cloneSideSettings,
  isPreset,
  type Preset,
  type PresetLibrary,
} from '../contracts';
import { createBuiltinPresets } from './builtin';

const DB_NAME = 'squish-presets';
const STORE_NAME = 'presets';

/**
 * Real presets are stored under this key prefix so a reserved `meta:` key
 * (the "have we seeded built-ins yet" flag) can live in the same object
 * store without ever being mistaken for a user preset.
 */
const PRESET_KEY_PREFIX = 'preset:';
const SEEDED_KEY = 'meta:seeded-builtins';

function presetKey(name: string): string {
  return PRESET_KEY_PREFIX + name;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers (idb-free, unit-testable)                                     */
/* -------------------------------------------------------------------------- */

/** Sorted by display name. Pure. */
export function sortPresets(presets: readonly Preset[]): Preset[] {
  return [...presets].sort((a, b) => a.name.localeCompare(b.name));
}

/** Inserts `next`, replacing any existing preset with the same name. Pure. */
export function upsertPreset(current: readonly Preset[], next: Preset): Preset[] {
  return sortPresets([...current.filter((p) => p.name !== next.name), next]);
}

/** Bulk version of {@link upsertPreset} — later entries in `incoming` win on name collisions. Pure. */
export function upsertPresets(current: readonly Preset[], incoming: readonly Preset[]): Preset[] {
  const byName = new Map(current.map((p) => [p.name, p] as const));
  for (const preset of incoming) byName.set(preset.name, preset);
  return sortPresets([...byName.values()]);
}

/* -------------------------------------------------------------------------- */
/* Library                                                                     */
/* -------------------------------------------------------------------------- */

export interface PresetLibraryOptions {
  /** Custom idb-keyval store, mainly for tests. Defaults to a dedicated `squish-presets` IndexedDB database. */
  store?: UseStore;
  /** Seed the built-in starter presets on first run (empty store). Defaults to `true`. */
  seedBuiltins?: boolean;
}

export function createPresetLibrary(options: PresetLibraryOptions = {}): PresetLibrary {
  const store = options.store ?? createStore(DB_NAME, STORE_NAME);
  const seedBuiltins = options.seedBuiltins ?? true;

  let presets = $state<Preset[]>([]);

  let readyResolve!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  async function load(): Promise<void> {
    try {
      const stored = await idbEntries<IDBValidKey, unknown>(store);
      const loaded: Preset[] = [];
      for (const [key, value] of stored) {
        if (typeof key === 'string' && key.startsWith(PRESET_KEY_PREFIX) && isPreset(value)) {
          loaded.push(value);
        }
      }

      let merged = sortPresets(loaded);

      if (seedBuiltins) {
        const alreadySeeded = (await idbGet<boolean>(SEEDED_KEY, store)) ?? false;
        if (!alreadySeeded) {
          const missing = createBuiltinPresets().filter(
            (builtin) => !loaded.some((p) => p.name === builtin.name),
          );
          if (missing.length > 0) {
            await idbSetMany(
              missing.map((p): [IDBValidKey, Preset] => [presetKey(p.name), p]),
              store,
            );
            merged = upsertPresets(merged, missing);
          }
          await idbSet(SEEDED_KEY, true, store);
        }
      }

      presets = merged;
    } catch {
      // IndexedDB unavailable (private browsing, disabled storage, an old
      // browser…) — fall back to an in-memory, non-persistent set of
      // built-ins so there's still something to show and CRUD ops still
      // work for the session, they just won't survive a reload.
      presets = seedBuiltins ? sortPresets(createBuiltinPresets()) : [];
    } finally {
      readyResolve();
    }
  }

  void load();

  return {
    get presets() {
      return presets;
    },
    ready: readyPromise,

    get(name) {
      return presets.find((p) => p.name === name);
    },

    async save(name, side) {
      const preset: Preset = { v: PRESET_VERSION, name, side: cloneSideSettings(side) };
      await idbSet(presetKey(name), preset, store);
      presets = upsertPreset(presets, preset);
      return preset;
    },

    async remove(name) {
      if (!presets.some((p) => p.name === name)) return;
      await idbDel(presetKey(name), store);
      presets = presets.filter((p) => p.name !== name);
    },

    async rename(oldName, newName) {
      if (oldName === newName) return;
      const existing = presets.find((p) => p.name === oldName);
      if (!existing) return;
      const renamed: Preset = { ...existing, name: newName };
      await idbSet(presetKey(newName), renamed, store);
      await idbDel(presetKey(oldName), store);
      presets = upsertPreset(
        presets.filter((p) => p.name !== oldName),
        renamed,
      );
    },

    async import(incoming) {
      const valid = incoming.filter(isPreset);
      if (valid.length === 0) return;
      await idbSetMany(
        valid.map((p): [IDBValidKey, Preset] => [presetKey(p.name), p]),
        store,
      );
      presets = upsertPresets(presets, valid);
    },

    async clear() {
      await idbClear(store);
      presets = [];
    },
  };
}

/** Shared app-wide instance. Most call sites should use this rather than constructing their own. */
export const presetLibrary = createPresetLibrary();
