<script lang="ts">
  /**
   * Left-hand section nav of the Settings screen (comp 05): rounded ink-
   * bordered cards, one per {@link SettingsSectionId}, each carrying its own
   * accent dot. The active card is the one blue fill the whole design reuses
   * for "currently open" — not the section's own accent, which only colours
   * the dot while inactive.
   *
   * Below 900px this degrades to a horizontal, scrollable pill strip — there
   * is no mobile comp for Settings, so this follows the same "scroll rather
   * than shrink further" rule as the tab strip.
   */
  import { BrandDot, cursorFlair } from '../ui';
  import type { AccentName } from '../ui';
  import { SETTINGS_SECTIONS, type SettingsSectionId } from '../contracts';

  /** Blob fill per section. `about` blooms in ink, the rest in their accent. */
  const FLAIR_COLOR: Record<AccentName, string> = {
    blue: 'var(--accent-blue)',
    red: 'var(--accent-red)',
    yellow: 'var(--accent-yellow)',
    green: 'var(--accent-green)',
    purple: 'var(--accent-purple)',
    ink: 'var(--ink)',
    muted: 'var(--muted)',
  };

  interface Props {
    active: SettingsSectionId;
    onSelect: (id: SettingsSectionId) => void;
  }

  let { active, onSelect }: Props = $props();

  const SECTION_META: Record<SettingsSectionId, { label: string; accent: AccentName }> = {
    defaults: { label: 'Defaults', accent: 'blue' },
    encoders: { label: 'Encoders', accent: 'red' },
    presets: { label: 'Presets', accent: 'yellow' },
    metrics: { label: 'Metrics', accent: 'green' },
    shortcuts: { label: 'Shortcuts', accent: 'purple' },
    about: { label: 'About', accent: 'ink' },
  };
</script>

<nav class="nav" aria-label="Settings sections">
  {#each SETTINGS_SECTIONS as id (id)}
    {@const meta = SECTION_META[id]}
    {@const isActive = id === active}
    <button
      type="button"
      class="item"
      class:active={isActive}
      data-accent={meta.accent}
      aria-current={isActive ? 'page' : undefined}
      onclick={() => onSelect(id)}
      use:cursorFlair={{ color: FLAIR_COLOR[meta.accent], enabled: !isActive }}
    >
      <BrandDot accent={isActive ? 'var(--paper-white)' : meta.accent} size={11} />
      <span class="label">{meta.label}</span>
      <span class="spacer"></span>
      <span class="arrow" aria-hidden="true">↗</span>
    </button>
  {/each}
</nav>

<style>
  .nav {
    width: 248px;
    box-sizing: border-box;
    flex: none;
    border-right: var(--border-hairline);
    padding: var(--space-6) 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .item {
    margin: 0 var(--space-4);
    padding: 11px 14px;
    background: var(--paper);
    color: var(--ink);
    border: var(--border-ink);
    border-radius: var(--radius-lg);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono-wide);
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 9px;
    text-align: left;
  }

  .item:hover:not(.active) {
    background: var(--cream);
  }

  /* ── Cursor flair (cursorFlair action) ─────────────────────────────
     The blob itself is styled globally in app.css because the action injects
     it outside Svelte's scope. Here we only clip it to the card and lift the
     content above it. */
  .item {
    position: relative;
    overflow: hidden;
  }

  .item > :global(:not(.flair)) {
    position: relative;
    z-index: 1;
  }

  /* The active card is a solid blue fill; no blob on top of it. */
  .active :global(.flair) {
    display: none;
  }

  /* Content flips to a readable color as the blob covers the card. Yellow
     keeps ink text; every other accent is dark enough for cream. */
  .item:hover:not(.active):not([data-accent='yellow']) {
    color: var(--cream);
    transition: color 200ms ease 120ms;
  }

  .spacer {
    flex: 1;
  }

  .arrow {
    font-size: var(--fs-xs);
    opacity: 0.55;
  }

  .active {
    background: var(--accent-blue);
    color: var(--paper-white);
  }

  .active .arrow {
    opacity: 1;
  }

  @media (width <= 900px) {
    .nav {
      width: 100%;
      flex-direction: row;
      overflow-x: auto;
      overscroll-behavior-x: contain;
      -webkit-overflow-scrolling: touch;
      border-right: none;
      border-bottom: var(--border-hairline);
      padding: var(--space-4) var(--space-5);
      gap: var(--space-2);
    }

    .item {
      margin: 0;
      flex: none;
    }

    .spacer {
      display: none;
    }

    .arrow {
      display: none;
    }
  }
</style>
