<script lang="ts">
  /**
   * Screen 05, section `/ 05`. No comp exists for this section; the key chip
   * (border + padding, no fill) is lifted straight from the ⌘K hint on the
   * Home top bar (comp 01).
   */
  import { Chip } from '../ui';
  import SectionHeader from './SectionHeader.svelte';

  interface ShortcutRow {
    keys: readonly string[];
    description: string;
    soon?: boolean;
  }

  const rows: readonly ShortcutRow[] = [
    { keys: ['⌘S'], description: 'Download the current encode.' },
    { keys: ['1', '2', '3'], description: 'Snap the reveal divider to 25% · 50% · 75%.' },
    { keys: ['←', '→'], description: 'Step the quality slider by 1.' },
    { keys: ['⌘W'], description: 'Close the active tab.' },
    { keys: ['Esc'], description: 'Close the open panel or dialog.' },
    { keys: ['⌘K'], description: 'Open the file picker.' },
  ];
</script>

<div class="section">
  <SectionHeader accent="purple" index={5} title="Shortcuts" />

  <div class="rows">
    {#each rows as row (row.description)}
      <div class="row">
        <div class="keys">
          {#each row.keys as key (key)}
            <span class="key mono">{key}</span>
          {/each}
        </div>
        <span class="description">{row.description}</span>
        {#if row.soon}<Chip tone="muted">Soon</Chip>{/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .section {
    display: flex;
    flex-direction: column;
  }

  .rows {
    border-top: var(--border-ink);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-5);
    padding: var(--space-4) 0;
    border-bottom: var(--border-hairline);
  }

  .keys {
    display: flex;
    gap: 6px;
    flex: none;
    width: 108px;
  }

  .key {
    border: 1.5px solid var(--hairline);
    border-radius: var(--radius-thumb);
    padding: 5px 9px;
    font-size: var(--fs-mono-md);
    color: var(--ink);
  }

  .description {
    flex: 1;
    font-size: var(--fs-sm);
    color: var(--muted);
    min-width: 0;
  }

  @media (width <= 640px) {
    .row {
      flex-wrap: wrap;
    }

    .keys {
      width: auto;
    }

    .description {
      order: 3;
      flex-basis: 100%;
    }
  }
</style>
