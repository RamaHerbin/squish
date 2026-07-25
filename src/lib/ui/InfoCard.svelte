<script lang="ts">
  /**
   * The floating read-out card from the editor canvas: "Original" on paper
   * with an ink border (top-left) and "Output" as an ink slab with cream text
   * (top-right). 12px radius, 12/16 padding, a mono caps label over whatever
   * you render as children.
   *
   * Pointer-transparent by default so it never blocks the reveal handle —
   * pass `interactive` when the card contains a control.
   */
  import type { Snippet } from 'svelte';
  import type { CardVariant } from './types';

  interface Props {
    children: Snippet;
    /** Mono caps label on the first line. */
    label?: string;
    variant?: CardVariant;
    /** Column alignment. The Output card in the comp is right-aligned. */
    align?: 'start' | 'end';
    /** Allow pointer events (default: the card is decoration). */
    interactive?: boolean;
    /** Ink cards carry no border in the comp; force one if you need it. */
    bordered?: boolean;
  }

  let {
    children,
    label,
    variant = 'paper',
    align = 'start',
    interactive = false,
    bordered = variant === 'paper',
  }: Props = $props();
</script>

<div
  class="info-card {variant} align-{align}"
  class:bordered
  class:interactive
>
  {#if label}<span class="label">{label}</span>{/if}
  {@render children()}
</div>

<style>
  .info-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: 12px 16px;
    border-radius: var(--radius-lg);
    pointer-events: none;
  }

  .interactive {
    pointer-events: auto;
  }

  .paper {
    background: var(--paper);
    color: var(--ink);
  }

  .ink {
    background: var(--ink);
    color: var(--cream);
  }

  .bordered {
    border: var(--border-ink);
  }

  .align-end {
    align-items: flex-end;
    text-align: right;
  }

  .label {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono-wider);
    text-transform: uppercase;
    color: var(--muted);
  }

  .ink .label {
    color: var(--cream-muted);
  }
</style>
