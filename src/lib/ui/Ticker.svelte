<script lang="ts">
  /**
   * The 52px status bar that closes a screen: yellow with ink text on Home,
   * ink with cream text at the foot of the Queue. 1.5px ink rule on top,
   * Space Mono 10px caps, content pushed to the two edges.
   *
   * Pass `left`/`right` snippets, or just `children` for a single run of
   * content.
   */
  import type { Snippet } from 'svelte';

  interface Props {
    variant?: 'yellow' | 'ink' | 'paper';
    left?: Snippet;
    right?: Snippet;
    /** Alternative to `left` when there is nothing on the right. */
    children?: Snippet;
    /** Horizontal padding; 32px on Home, 24px on the Queue. */
    padding?: string;
    /** Announce content changes (encode progress) politely. */
    live?: boolean;
  }

  let {
    variant = 'yellow',
    left,
    right,
    children,
    padding = '32px',
    live = false,
  }: Props = $props();
</script>

<div
  class="ticker {variant}"
  style="--ticker-px: {padding};"
  role={live ? 'status' : undefined}
  aria-live={live ? 'polite' : undefined}
>
  <div class="side">
    {#if left}{@render left()}{:else if children}{@render children()}{/if}
  </div>
  {#if right}
    <div class="side end">{@render right()}</div>
  {/if}
</div>

<style>
  .ticker {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    block-size: var(--h-ticker);
    flex: none;
    padding-inline: var(--ticker-px);
    border-top: var(--border-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .yellow {
    background: var(--accent-yellow);
    color: var(--ink);
  }

  .ink {
    background: var(--ink);
    color: var(--cream);
  }

  .paper {
    background: var(--paper);
    color: var(--ink);
  }

  .side {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-inline-size: 0;
  }

  .end {
    justify-content: flex-end;
    flex: none;
  }

  @media (width <= 640px) {
    .ticker {
      padding-inline: var(--space-5);
      font-size: var(--fs-mono-xs);
      letter-spacing: var(--tracking-mono-wide);
    }
  }
</style>
