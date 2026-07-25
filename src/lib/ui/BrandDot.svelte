<script lang="ts">
  /**
   * The rounded ink-bordered square that marks every heading in the design —
   * 13px in the top bar and section headers, 11px in the tab strip and the
   * settings nav, 12px in the advanced drawer.
   *
   * Decorative by default (`aria-hidden`); pass `label` to expose it, e.g. the
   * per-encoder colour key.
   */
  import { accentFill } from './types';
  import type { AccentName } from './types';

  interface Props {
    /** Accent name, or any CSS colour string. */
    accent?: AccentName | string;
    /** Edge length in px. 13 = section header, 11 = inline chrome. */
    size?: number;
    /** Corner radius in px. */
    radius?: number;
    /** Accessible name. Omit to keep the dot decorative. */
    label?: string;
  }

  let { accent = 'blue', size = 13, radius = 3, label }: Props = $props();

  const fill = $derived(accentFill(accent));
</script>

<span
  class="brand-dot"
  style="--dot-size: {size}px; --dot-radius: {radius}px; --dot-fill: {fill};"
  role={label ? 'img' : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : 'true'}
></span>

<style>
  .brand-dot {
    display: inline-block;
    flex: none;
    inline-size: var(--dot-size);
    block-size: var(--dot-size);
    background: var(--dot-fill);
    border: var(--border-ink);
    border-radius: var(--dot-radius);
  }
</style>
