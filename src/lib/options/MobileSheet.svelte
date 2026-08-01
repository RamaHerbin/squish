<script lang="ts">
  /**
   * The 390px editor sheet of comp 06b: a row of codec pills (plus a `▾` that
   * opens the full encoder list), the quality slider with a 20px thumb, one
   * line of metrics, the "Advanced settings ›" row, and a 52px download pill
   * carrying the output size — beside an outline Share pill when the platform
   * has a share sheet to offer.
   *
   * Same props as `Toolbar` — the editor hands both the identical data and
   * lets CSS decide which one is on screen (see `EditorControls`).
   */
  import { EditorialSlider, PillButton } from '../ui';
  import { verdictFor, withEncoder, type EncoderId, type SideSettings } from '../contracts';
  import AdvancedDrawer from './AdvancedDrawer.svelte';
  import EncoderPopover from './EncoderPopover.svelte';
  import ResizeControl from './ResizeControl.svelte';
  import { formatBytes, formatSavings, formatSsim } from './format';
  import { hasAdvanced, primaryKnob } from './knobs';
  import type { MobileSheetProps } from './types';

  let {
    registry,
    supportedEncoderIds,
    settings,
    onchange,
    fileName: _fileName,
    originalBytes,
    sourceWidth,
    sourceHeight,
    outputBytes,
    encoding = false,
    error,
    metrics,
    verdict,
    metricsNote,
    onDownload,
    downloadDisabled = false,
    onShare,
    advancedOpen,
    onAdvancedToggle,
  }: MobileSheetProps = $props();

  /** The four codecs the comp puts one tap away; everything else is behind `▾`. */
  const QUICK_ENCODERS: readonly EncoderId[] = ['mozjpeg', 'webp', 'avif', 'oxipng'];

  const quick = $derived.by((): EncoderId[] => {
    const ids = QUICK_ENCODERS.filter(
      (id) => !supportedEncoderIds || supportedEncoderIds.has(id) || id === settings.encoderId,
    );
    // Whatever is selected is always visible, even when it is not a quick pick.
    return ids.includes(settings.encoderId) ? ids : [settings.encoderId, ...ids.slice(0, 3)];
  });

  const knob = $derived(primaryKnob(settings));
  const advanced = $derived(hasAdvanced(settings.encoderId));
  const shownVerdict = $derived(verdict ?? (metrics ? verdictFor(metrics.ssim) : null));
  const canDownload = $derived(!downloadDisabled && onDownload !== undefined && !encoding);

  function pickEncoder(id: EncoderId): void {
    // See the note in `Toolbar.svelte`: `id` is not a literal here, so the
    // return type widens and has to be asserted back to the union.
    onchange(withEncoder(settings, id) as SideSettings);
  }
</script>

<section class="sheet" aria-label="Encode settings">
  {#if advancedOpen && advanced}
    <AdvancedDrawer {settings} {onchange} {registry} compact onCollapse={() => onAdvancedToggle(false)} />
  {/if}

  <div class="body">
    <div class="codecs">
      {#each quick as id, index (id)}
        <button
          type="button"
          class="codec"
          class:selected={id === settings.encoderId}
          style="--grow: {index === 0 ? 1.35 : 1};"
          aria-pressed={id === settings.encoderId}
          onclick={() => pickEncoder(id)}
        >
          {registry[id].label}
        </button>
      {/each}
      <EncoderPopover
        value={settings.encoderId}
        {registry}
        {supportedEncoderIds}
        onValue={pickEncoder}
        placement="top-end"
        compact
      />
    </div>

    {#if knob.kind === 'none'}
      {#if knob.note}<p class="knob-note mono-label mono-label--xs">{knob.note}</p>{/if}
    {:else}
      <EditorialSlider
        label={knob.label}
        value={knob.value}
        valueText={knob.valueText}
        min={knob.min}
        max={knob.max}
        step={knob.step}
        disabled={knob.disabled}
        ariaValueText={knob.ariaValueText}
        size="lg"
        onValue={(next) => onchange(knob.apply(next))}
      />
    {/if}

    <div class="metrics">
      <span class="mono-label mono-label--md">SSIM {formatSsim(metrics?.ssim)}</span>
      {#if shownVerdict}
        <span class="verdict mono-label mono-label--md" data-tone={shownVerdict.tone}>
          {shownVerdict.label}
        </span>
      {:else}
        <span class="mono-label mono-label--md">{encoding ? 'Measuring…' : 'Not measured'}</span>
      {/if}
    </div>

    {#if metricsNote}
      <p class="note mono-label mono-label--xs">{metricsNote}</p>
    {/if}

    <div class="resize">
      <ResizeControl {settings} {onchange} {sourceWidth} {sourceHeight} placement="top-start" />
    </div>

    {#if advanced}
      <button
        type="button"
        class="advanced"
        aria-expanded={advancedOpen}
        onclick={() => onAdvancedToggle(!advancedOpen)}
      >
        <span>Advanced settings</span>
        <span class="chevron" aria-hidden="true">{advancedOpen ? '˅' : '›'}</span>
      </button>
    {/if}

    {#if error}
      <p class="error mono-label mono-label--xs">{error}</p>
    {/if}

    <!-- Wrappers rather than classes on the pills: the primitive owns its own
         class list, so the row's flex sizing lives outside it. -->
    <div class="actions">
      <div class="action-grow">
        <PillButton
          size={52}
          variant="solid"
          fullWidth
          disabled={!canDownload}
          onclick={() => onDownload?.()}
        >
          Download
          {#snippet trailing()}
            <span class="download-size">
              {#if outputBytes === undefined}
                {encoding ? 'Encoding…' : '—'}
              {:else}
                {formatBytes(outputBytes)} · {formatSavings(originalBytes, outputBytes)}
              {/if}
            </span>
          {/snippet}
        </PillButton>
      </div>

      {#if onShare}
        <PillButton size={52} variant="outline" disabled={!canDownload} onclick={() => onShare?.()}>
          Share
        </PillButton>
      {/if}
    </div>
  </div>
</section>

<style>
  .sheet {
    display: flex;
    flex-direction: column;
    flex: none;
    border-top: var(--border-ink);
    background: var(--paper);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 18px 20px 20px;
  }

  .codecs {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .codec {
    flex: var(--grow) 1 0;
    min-inline-size: 0;
    block-size: var(--h-control-lg);
    padding-inline: var(--space-2);
    border: var(--border-ink);
    border-radius: var(--radius-pill);
    background: transparent;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono-tight);
    text-transform: uppercase;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .codec.selected {
    border-color: transparent;
    background: var(--accent-blue);
    color: var(--paper-white);
  }

  .knob-note,
  .note {
    color: var(--muted);
  }

  .metrics {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .verdict {
    color: var(--muted);
  }

  .verdict[data-tone='good'] {
    color: var(--accent-green-dark);
  }

  .verdict[data-tone='warn'] {
    color: var(--accent-red);
  }

  .resize {
    display: flex;
    flex-direction: column;
  }

  .advanced {
    display: flex;
    align-items: center;
    justify-content: space-between;
    inline-size: 100%;
    block-size: var(--h-control-lg);
    padding-inline: 14px;
    border: var(--border-ink);
    border-radius: var(--radius-pill);
    background: transparent;
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono);
    text-transform: uppercase;
  }

  .chevron {
    color: var(--muted);
  }

  .error {
    color: var(--accent-red);
  }

  .actions {
    display: flex;
    align-items: stretch;
    gap: 8px;
  }

  /* Download keeps the whole row when Share is absent, and yields exactly what
     Share needs when it is there. `min-inline-size: 0` so the size trailer
     truncates instead of pushing Share off the sheet. */
  .action-grow {
    flex: 1;
    min-inline-size: 0;
  }

  .download-size {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono-wide);
    color: var(--cream-muted);
  }
</style>
