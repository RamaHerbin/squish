<script lang="ts" module>
  let counter = 0;

  function nextUid(): string {
    counter += 1;
    return `pinch-advanced-${counter}`;
  }
</script>

<script lang="ts">
  /**
   * The advanced drawer of comp 02b: a panel that expands directly above the
   * toolbar, headed by a purple mark, the encoder's name, "Reset to defaults"
   * and "Collapse ˅", with the encoder's full option set laid out in a
   * four-column grid.
   *
   * The columns come from `advanced.ts`, which owns every codec-specific rule
   * (AVIF's inverted effort, JPEG XL's auto edge filter, libwebp's inverted
   * sharpness…). This component only decides which primitive draws which
   * field — it knows nothing about codecs.
   *
   * `compact` is the mobile build: one column, scrollable.
   */
  import { BrandDot, EditorialCheckbox, EditorialSelect, EditorialSlider } from '../ui';
  import {
    advancedColumns,
    advancedNote,
    countFields,
    createOptionMemory,
    rememberOptions,
    resetToDefaults,
  } from './advanced';
  import type { AdvancedDrawerProps } from './types';

  let { settings, onchange, registry, onCollapse, compact = false }: AdvancedDrawerProps =
    $props();

  const uid = nextUid();

  /*
   * "Last lossy value" memory: turning Lossless off restores what the user had
   * rather than the codec default. The old per-encoder panels each kept this
   * in component state; here one memory serves every encoder.
   */
  let memory = $state(createOptionMemory());

  $effect(() => {
    memory = rememberOptions(memory, settings);
  });

  const columns = $derived(advancedColumns(settings, memory));
  const fieldCount = $derived(countFields(columns));
  const encoderName = $derived(registry?.[settings.encoderId].label ?? settings.encoderId);
</script>

<section class="drawer" class:compact aria-label="Advanced settings">
  <header class="head">
    <div class="head-start">
      <span class="title">
        <BrandDot accent="purple" size={12} />
        <span class="title-text">Advanced settings</span>
      </span>
      <span class="encoder mono-label mono-label--xs">{encoderName}</span>
    </div>
    <div class="head-end">
      <button type="button" class="link" onclick={() => onchange(resetToDefaults(settings))}>
        Reset to defaults
      </button>
      {#if onCollapse}
        <button type="button" class="link link--ink" onclick={onCollapse}>Collapse ˅</button>
      {/if}
    </div>
  </header>

  {#if fieldCount === 0}
    <p class="note">{advancedNote(settings.encoderId)}</p>
  {:else}
    <div class="grid">
      {#each columns as column (column.id)}
        <div class="column">
          {#each column.fields as field (field.id)}
            {#if field.kind === 'select'}
              <div class="field">
                <span class="mono-label" id="{uid}-{field.id}">{field.label}</span>
                <EditorialSelect
                  value={field.value}
                  options={field.options}
                  labelledBy="{uid}-{field.id}"
                  disabled={field.disabled}
                  fullWidth
                  onValue={(next) => onchange(field.apply(next))}
                />
                {#if field.hint}<span class="hint">{field.hint}</span>{/if}
              </div>
            {:else if field.kind === 'slider'}
              <div class="field field--slider">
                <EditorialSlider
                  label={field.label}
                  value={field.value}
                  valueText={field.valueText}
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  disabled={field.disabled}
                  onValue={(next) => onchange(field.apply(next))}
                />
                {#if field.hint}<span class="hint">{field.hint}</span>{/if}
              </div>
            {:else}
              <EditorialCheckbox
                checked={field.value}
                label={field.label}
                hint={field.hint}
                disabled={field.disabled}
                onValue={(next) => onchange(field.apply(next))}
              />
            {/if}
          {/each}
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .drawer {
    display: flex;
    flex-direction: column;
    flex: none;
    gap: var(--space-5);
    padding: 22px 24px 24px;
    border-top: var(--border-ink);
    background: var(--paper);
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }

  .head-start {
    display: flex;
    align-items: baseline;
    gap: var(--space-4);
  }

  .title {
    display: inline-flex;
    align-items: center;
    gap: 9px;
  }

  .title-text {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    font-weight: 700;
    letter-spacing: var(--tracking-mono-wider);
    text-transform: uppercase;
  }

  .encoder {
    letter-spacing: var(--tracking-mono-wide);
  }

  .head-end {
    display: flex;
    align-items: center;
    gap: var(--space-6);
  }

  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono-wide);
    text-transform: uppercase;
    white-space: nowrap;
  }

  .link--ink {
    color: var(--ink);
  }

  .link:hover {
    color: var(--accent-blue);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 40px;
  }

  .column {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    min-inline-size: 0;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-inline-size: 0;
  }

  .field--slider {
    gap: var(--space-1);
  }

  /* The drawer's slider readouts are 13px, not the toolbar's 17px. */
  .field--slider :global(output) {
    font-size: var(--fs-mono-lg);
    min-inline-size: 0;
  }

  .hint {
    font-size: var(--fs-xs);
    color: var(--muted);
  }

  .note {
    font-size: var(--fs-sm);
    color: var(--muted);
    max-inline-size: 62ch;
  }

  /* --- Narrow ------------------------------------------------------------ */

  @media (width <= 1100px) {
    .grid {
      grid-template-columns: repeat(2, 1fr);
      gap: var(--space-6) var(--space-7);
    }
  }

  @media (width <= 720px) {
    .drawer {
      padding: 18px 20px 20px;
    }

    .grid {
      grid-template-columns: 1fr;
    }
  }

  .compact {
    gap: var(--space-4);
    padding: 16px 20px 18px;
    max-block-size: 44vh;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .compact .grid {
    grid-template-columns: 1fr;
    gap: var(--space-5);
  }
</style>
