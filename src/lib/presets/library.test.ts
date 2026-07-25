import { describe, expect, it } from 'vitest';

import { createSideSettings, isPreset, type Preset } from '../contracts';
import { createPresetLibrary, sortPresets, upsertPreset, upsertPresets } from './library.svelte';

function makePreset(name: string): Preset {
  return { v: 1, name, side: createSideSettings('mozjpeg') };
}

describe('sortPresets (pure)', () => {
  it('sorts by name, case-sensitively-ish (locale compare)', () => {
    const input = [makePreset('Charlie'), makePreset('alpha'), makePreset('Bravo')];
    expect(sortPresets(input).map((p) => p.name)).toEqual(['alpha', 'Bravo', 'Charlie']);
  });

  it('does not mutate the input array', () => {
    const input = [makePreset('b'), makePreset('a')];
    const copy = [...input];
    sortPresets(input);
    expect(input).toEqual(copy);
  });
});

describe('upsertPreset (pure)', () => {
  it('appends a new preset, keeping the list sorted', () => {
    const current = [makePreset('alpha'), makePreset('charlie')];
    const next = upsertPreset(current, makePreset('bravo'));
    expect(next.map((p) => p.name)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('replaces an existing preset with the same name instead of duplicating it', () => {
    const current = [makePreset('alpha'), makePreset('bravo')];
    const replacement: Preset = { v: 1, name: 'alpha', side: createSideSettings('avif') };
    const next = upsertPreset(current, replacement);
    expect(next).toHaveLength(2);
    expect(next.find((p) => p.name === 'alpha')?.side.encoderId).toBe('avif');
  });
});

describe('upsertPresets (pure, bulk)', () => {
  it('merges by name, later entries winning on collisions', () => {
    const current = [makePreset('alpha'), makePreset('bravo')];
    const incoming = [
      { v: 1 as const, name: 'alpha', side: createSideSettings('webp') },
      makePreset('charlie'),
    ];
    const next = upsertPresets(current, incoming);
    expect(next.map((p) => p.name)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(next.find((p) => p.name === 'alpha')?.side.encoderId).toBe('webp');
  });

  it('is a no-op-ish merge when incoming is empty', () => {
    const current = [makePreset('alpha')];
    expect(upsertPresets(current, [])).toEqual(current);
  });
});

describe('createPresetLibrary', () => {
  it('resolves `ready` and ends up with a valid, non-empty preset list', async () => {
    // Works whether IndexedDB is available (browser) or not (this test
    // runner) — createPresetLibrary falls back to in-memory built-ins when
    // storage is unavailable, so `ready` always resolves and `presets` is
    // always populated.
    const library = createPresetLibrary();
    await library.ready;
    expect(library.presets.length).toBeGreaterThan(0);
    expect(library.presets.every(isPreset)).toBe(true);
    // Sorted by name.
    const names = library.presets.map((p) => p.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('can be created with built-in seeding disabled', async () => {
    const library = createPresetLibrary({ seedBuiltins: false });
    await library.ready;
    // With no IndexedDB and seeding disabled, there is nothing to show.
    // (In a real browser with IndexedDB this would reflect the user's
    // previously-saved presets instead.)
    expect(Array.isArray(library.presets)).toBe(true);
  });
});
