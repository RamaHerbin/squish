/**
 * Barrel for the presets feature. UI code elsewhere in the app should import
 * from here rather than reaching into individual files.
 */

export {
  MAX_PRESET_TOKEN_BYTES,
  PresetDecodeError,
  PresetTooLargeError,
  buildPresetShareUrl,
  decodePresetToken,
  encodePresetToken,
  presetCodec,
  readPresetFromLocation,
  type LocationLike,
} from './codec';

export {
  createPresetLibrary,
  presetLibrary,
  sortPresets,
  upsertPreset,
  upsertPresets,
  type PresetLibraryOptions,
} from './library.svelte';

export { createBuiltinPresets } from './builtin';

