<script lang="ts">
  /**
   * The small mono pill that annotates everything in the design: the home
   * stats ("9 · AVIF · WEBP · JPEG XL…"), format tags on the sample cards,
   * encoder notes in the picker, verdicts in the matrix, codec tags in the
   * queue.
   *
   * Two builds, both straight off the comp:
   * - outline (default) — 1.3px accent border, accent text, transparent fill
   * - `filled`          — accent fill, white text, 1.5px ink border
   */
  import type { Snippet } from 'svelte';
  import { accentFill, accentText } from './types';
  import type { AccentName } from './types';

  interface Props {
    children: Snippet;
    /** Accent name or any CSS colour. */
    tone?: AccentName | string;
    /** Solid accent fill with an ink border, as in the queue's codec column. */
    filled?: boolean;
    /** `xs` = 9.5px (inline tags), `sm` = 11px (stat rows). */
    size?: 'xs' | 'sm';
    /** Caps + wide tracking. Off for sentence-case verdicts. */
    uppercase?: boolean;
    title?: string;
  }

  let {
    children,
    tone = 'blue',
    filled = false,
    size = 'sm',
    uppercase = true,
    title,
  }: Props = $props();

  const fill = $derived(accentFill(tone));
  const text = $derived(accentText(tone));
</script>

<span
  class="chip {size}"
  class:filled
  class:uppercase
  {title}
  style="--chip-fill: {fill}; --chip-text: {text};"
>
  {@render children()}
</span>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    border: var(--border-chip) solid var(--chip-text);
    border-radius: var(--radius-pill);
    padding: 2px 9px;
    color: var(--chip-text);
    font-family: var(--font-mono);
    font-weight: 700;
    letter-spacing: var(--tracking-mono-tight);
    white-space: nowrap;
    line-height: 1.4;
  }

  .uppercase {
    text-transform: uppercase;
    letter-spacing: var(--tracking-mono);
  }

  .xs {
    font-size: 9.5px;
    padding: 2px 8px;
  }

  .sm {
    font-size: var(--fs-mono-md);
  }

  .filled {
    background: var(--chip-fill);
    color: var(--paper-white);
    border: var(--border-ink);
    padding: 4px 9px;
    font-size: var(--fs-mono-sm);
  }
</style>
