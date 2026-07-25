<script lang="ts">
  /**
   * The auto-suggestion strip that floats at the top centre of the editor
   * canvas (comp "02 Editor"): a filled accent segment reading `AUTO`, the
   * suggestion sentence, then a segment divided off by a 1px ink rule — a
   * static `Applied` read-out, or a button when `onaction` is supplied.
   *
   * Hidden entirely unless `open`, so the caller can leave it mounted.
   */
  import { accentFill } from '../ui';
  import type { AutoPillProps } from './reveal';

  let {
    open = false,
    message,
    label = 'Auto',
    actionLabel = 'Applied',
    onaction,
    accent = 'blue',
    live = true,
    compact = false,
    class: className = '',
  }: AutoPillProps = $props();
</script>

{#if open}
  <div
    class="auto-pill {className}"
    class:compact
    role={live ? 'status' : undefined}
    aria-live={live ? 'polite' : undefined}
  >
    <span class="tag" style:background={accentFill(accent)}>{label}</span>
    <span class="message" title={message}>{message}</span>
    {#if onaction}
      <button type="button" class="action action-button" onclick={onaction}>{actionLabel}</button>
    {:else}
      <span class="action">{actionLabel}</span>
    {/if}
  </div>
{/if}

<style>
  .auto-pill {
    display: flex;
    align-items: stretch;
    max-width: 100%;
    overflow: hidden;
    background: var(--paper);
    border: var(--border-ink);
    border-radius: var(--radius-pill);
    box-shadow: var(--shadow-card-soft);
  }

  .tag {
    display: flex;
    align-items: center;
    flex: none;
    padding: 10px 12px;
    color: var(--cream);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono-wider);
    text-transform: uppercase;
  }

  .message {
    display: flex;
    align-items: center;
    min-width: 0;
    padding: 10px 14px;
    font-size: var(--fs-sm);
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .action {
    display: flex;
    align-items: center;
    flex: none;
    padding: 10px 14px;
    border-left: 1px solid var(--ink);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono-wide);
    text-transform: uppercase;
    white-space: nowrap;
  }

  .action-button {
    margin: 0;
    border-top: 0;
    border-right: 0;
    border-bottom: 0;
    background: transparent;
    color: inherit;
    transition: background var(--duration-fast) var(--ease-standard);
  }

  .action-button:hover {
    background: var(--ink);
    color: var(--cream);
  }

  .action-button:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring-color);
    outline-offset: calc(var(--focus-ring-offset) * -1);
  }

  .compact .tag,
  .compact .message,
  .compact .action {
    padding: 8px 10px;
  }

  .compact .message {
    font-size: var(--fs-xs);
  }

  .compact .action {
    font-size: var(--fs-mono-sm);
  }

  @media (max-width: 640px) {
    .message {
      font-size: var(--fs-xs);
    }
  }
</style>
