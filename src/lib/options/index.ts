/**
 * Public surface of the options module: the editor's control surface — the
 * 108px toolbar, the encoder picker, the advanced drawer and the mobile sheet
 * — plus the pure logic that maps UI concepts onto real codec options.
 *
 * ```svelte
 * import { EditorControls } from '$lib/options';
 * ```
 *
 * Contracts-only dependencies: hand in an `EncoderRegistry`, a `SideSettings`
 * and an `onchange` callback. Nothing here touches `state/` or `codecs/`.
 */

export { default as EditorControls } from './EditorControls.svelte';
export { default as Toolbar } from './Toolbar.svelte';
export { default as AdvancedDrawer } from './AdvancedDrawer.svelte';
export { default as EncoderPopover } from './EncoderPopover.svelte';
export { default as MobileSheet } from './MobileSheet.svelte';
export { default as ResizeControl } from './ResizeControl.svelte';

export {
  ENCODER_NOTE,
  WEBP_LOSSLESS_PRESETS,
  encoderNote,
  hasAdvanced,
  isAvifLossless,
  isJxlLossless,
  isWebpLossless,
  primaryKnob,
  webpLosslessPreset,
  webpLosslessPresetValues,
  withEncoderOptions,
  withProcessorState,
} from './knobs';
export type { PrimaryKnob } from './knobs';

export {
  advancedColumns,
  advancedNote,
  countFields,
  createOptionMemory,
  rememberOptions,
  resetToDefaults,
} from './advanced';
export type {
  AdvancedCheckboxField,
  AdvancedColumn,
  AdvancedField,
  AdvancedSelectField,
  AdvancedSliderField,
  OptionMemory,
} from './advanced';

export {
  formatBytes,
  formatDelta,
  formatDimensions,
  formatQuality,
  formatSavings,
  formatSource,
  formatSsim,
} from './format';

export type {
  AdvancedDrawerProps,
  EditorControlsData,
  EncoderPopoverProps,
  MobileSheetProps,
  ResizeControlProps,
  ToolbarProps,
} from './types';
