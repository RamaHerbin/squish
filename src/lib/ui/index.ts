/**
 * "Pinch — Editorial" primitives.
 *
 * Every screen builds from these; none of them own layout, so they drop into
 * whatever grid the comp calls for. Colours come from the global tokens in
 * `src/app.css` — nothing here hard-codes a hex.
 *
 * ```svelte
 * import { PillButton, EditorialSlider, Chip } from '$lib/ui';
 * ```
 *
 * Conventions
 * - Callback props, never `createEventDispatcher`. Value-carrying controls all
 *   report through `onValue(next)`; the caller owns the state.
 * - Real semantic elements underneath (`button`, `input`, `select`), so focus,
 *   keyboard and screen readers work without extra wiring.
 * - Focus rings are the global 2px blue outline at 2px offset.
 */

export { default as BrandDot } from './BrandDot.svelte';
export { default as PillButton } from './PillButton.svelte';
export { default as Chip } from './Chip.svelte';
export { default as EditorialSlider } from './EditorialSlider.svelte';
export { default as EditorialToggle } from './EditorialToggle.svelte';
export { default as EditorialSelect } from './EditorialSelect.svelte';
export { default as EditorialCheckbox } from './EditorialCheckbox.svelte';
export { default as InfoCard } from './InfoCard.svelte';
export { default as StatCell } from './StatCell.svelte';
export { default as Ticker } from './Ticker.svelte';
export { default as Popover } from './Popover.svelte';

export {
  ACCENT_FILL,
  ACCENT_NAMES,
  ACCENT_TEXT,
  ENCODER_ACCENT,
  accentFill,
  accentText,
  isAccentName,
} from './types';

export type {
  AccentName,
  CardVariant,
  ControlFont,
  PillSize,
  PillVariant,
  PopoverPlacement,
  SelectOption,
} from './types';
