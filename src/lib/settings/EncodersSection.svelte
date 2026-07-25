<script lang="ts">
  /**
   * Screen 05, section `/ 02` — read-only capability list straight off
   * `ENCODER_REGISTRY`. No comp exists for this section; it borrows the
   * Defaults section's ruled-row rhythm and the matrix/queue's per-encoder
   * dot + chip vocabulary.
   */
  import { BrandDot, Chip, ENCODER_ACCENT } from '../ui';
  import { ENCODER_REGISTRY } from '../codecs';
  import { SELECTABLE_ENCODER_IDS } from './settings.svelte';
  import SectionHeader from './SectionHeader.svelte';
</script>

<div class="section">
  <SectionHeader accent="red" index={2} title="Encoders" />
  <p class="intro">
    Every codec Pinch ships, as data — pick a default on the Defaults tab.
  </p>

  <div class="rows">
    {#each SELECTABLE_ENCODER_IDS as id (id)}
      {@const meta = ENCODER_REGISTRY[id]}
      <div class="row">
        <div class="identity">
          <BrandDot accent={ENCODER_ACCENT[id]} size={13} />
          <div class="labels">
            <span class="label">{meta.label}</span>
            <span class="ext mono">.{meta.extension} · {meta.mimeType}</span>
          </div>
        </div>
        <div class="chips">
          <Chip tone="muted">{meta.usesWorker ? 'Wasm' : 'Browser'}</Chip>
          <Chip tone={meta.lossy ? 'red' : 'green'}>{meta.lossy ? 'Lossy' : 'Lossless'}</Chip>
          {#if meta.supportsAlpha}<Chip tone="ink">Alpha</Chip>{/if}
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .section {
    display: flex;
    flex-direction: column;
  }

  .intro {
    font-size: var(--fs-sm);
    color: var(--muted);
    max-width: 56ch;
    margin-bottom: var(--space-5);
  }

  .rows {
    border-top: var(--border-ink);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-6);
    padding: var(--space-4) 0;
    border-bottom: var(--border-hairline);
  }

  .identity {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }

  .labels {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .label {
    font-size: var(--fs-title);
    font-weight: var(--fw-strong);
  }

  .ext {
    font-size: var(--fs-mono-xs);
    letter-spacing: var(--tracking-mono-wide);
    color: var(--muted);
    text-transform: lowercase;
  }

  .chips {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: none;
  }

  @media (width <= 640px) {
    .row {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-2);
    }
  }
</style>
