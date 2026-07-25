<script lang="ts">
  /**
   * A label/number pair in the queue header and the editor toolbar: mono caps
   * label at 10px muted, mono value at 22px bold (`lg`) or 17px (`md`), and an
   * optional muted third line ("2.53 MB saved").
   *
   * Pass `value` for the common case, or `children` when the value needs its
   * own markup (a delta chip next to the number, say).
   */
  import type { Snippet } from 'svelte';
  import { accentText } from './types';
  import type { AccentName } from './types';

  interface Props {
    label: string;
    /** Rendered as the big mono figure. Ignored when `children` is given. */
    value?: string;
    children?: Snippet;
    /** Muted line under the value. */
    hint?: string;
    /** Value colour — savings are green, warnings red. */
    tone?: AccentName | string;
    /** `lg` = 22px (queue header), `md` = 17px (compact toolbar cells). */
    size?: 'md' | 'lg';
    align?: 'start' | 'end';
  }

  let {
    label,
    value,
    children,
    hint,
    tone = 'ink',
    size = 'lg',
    align = 'start',
  }: Props = $props();

  const color = $derived(accentText(tone));
</script>

<div class="stat align-{align}" style="--stat-color: {color};">
  <span class="label">{label}</span>
  <span class="value {size}">
    {#if children}{@render children()}{:else}{value}{/if}
  </span>
  {#if hint}<span class="hint">{hint}</span>{/if}
</div>

<style>
  .stat {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-inline-size: 0;
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
    white-space: nowrap;
  }

  .value {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--stat-color);
  }

  .lg {
    font-size: var(--fs-mono-2xl);
  }

  .md {
    font-size: var(--fs-mono-xl);
  }

  .hint {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono-tight);
    color: var(--muted);
    white-space: nowrap;
  }
</style>
