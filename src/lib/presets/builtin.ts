/**
 * Starter presets shown to a user who has never saved one of their own.
 *
 * `createBuiltinPresets` returns a brand-new array of brand-new `Preset`
 * objects on every call (built through `createSideSettings` /
 * `createDefaultProcessorState`, which already do this) so that no two
 * `PresetLibrary` instances — or two calls in tests — ever share mutable
 * state.
 */

import {
  PRESET_VERSION,
  createDefaultProcessorState,
  createSideSettings,
  type FitMethod,
  type Preset,
  type ProcessorState,
} from '../contracts';

function withResize(width: number, height: number, fitMethod: FitMethod = 'contain'): ProcessorState {
  const state = createDefaultProcessorState();
  state.resize = { ...state.resize, enabled: true, width, height, fitMethod };
  return state;
}

export function createBuiltinPresets(): Preset[] {
  return [
    {
      v: PRESET_VERSION,
      name: 'Web hero image — AVIF q50',
      side: createSideSettings('avif', { quality: 50 }),
    },
    {
      v: PRESET_VERSION,
      name: 'Lossless PNG — oxipng',
      side: createSideSettings('oxipng', { level: 4, optimiseAlpha: true }),
    },
    {
      v: PRESET_VERSION,
      name: 'Email photo — mozjpeg q75 + resize 1600w',
      side: createSideSettings('mozjpeg', { quality: 75 }, withResize(1600, 1200)),
    },
    {
      v: PRESET_VERSION,
      name: 'JXL archival — lossless',
      side: createSideSettings('jxl', { lossless: true, effort: 9 }),
    },
  ];
}
