<script lang="ts" module>
  let counter = 0;

  function nextUid(): string {
    counter += 1;
    return `pinch-toolbar-${counter}`;
  }
</script>

<script lang="ts">
  /**
   * The editor's single 108px toolbar (comp 02 / 02b). One row, six cells
   * divided by hairlines, a 1.5px ink rule along the top:
   *
   *   Source │ Encoder │ Quality │ Toggles │ Metrics │ Result + actions
   *
   * Everything is derived from the one `SideSettings` the editor owns — this
   * component holds no settings state of its own. The `Advanced ›` link and
   * the drawer it opens are the caller's state too, so the drawer can be
   * rendered as this bar's sibling (which is what comp 02b does).
   *
   * Below 1100px the cells wrap onto a second row rather than crushing; below
   * 720px the editor should switch to `MobileSheet` instead (see
   * `EditorControls`).
   */
  import { EditorialSlider, EditorialToggle } from '../ui';
  import { verdictFor, withEncoder, type EncoderId, type SideSettings } from '../contracts';
  import EncoderPopover from './EncoderPopover.svelte';
  import ResizeControl from './ResizeControl.svelte';
  import { formatBytes, formatDelta, formatSavings, formatSource, formatSsim } from './format';
  import { hasAdvanced, primaryKnob } from './knobs';
  import type { ToolbarProps } from './types';

  let {
    registry,
    supportedEncoderIds,
    settings,
    onchange,
    fileName,
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
    shortcut = true,
  }: ToolbarProps = $props();

  const uid = nextUid();

  const knob = $derived(primaryKnob(settings));
  const advanced = $derived(hasAdvanced(settings.encoderId));
  const shownVerdict = $derived(verdict ?? (metrics ? verdictFor(metrics.ssim) : null));
  const canDownload = $derived(!downloadDisabled && onDownload !== undefined && !encoding);

  function pickEncoder(id: EncoderId): void {
    // `withEncoder`'s generic collapses to the whole `EncoderId` union when the
    // id is not a literal (as here, coming out of the picker), so the return
    // type widens to `SideSettingsFor<EncoderId>` — safe to assert back, since
    // at runtime `id` really is one specific encoder.
    onchange(withEncoder(settings, id) as SideSettings);
  }

  /* ⌘S / Ctrl+S and ⇧⌘S — the shortcuts the two pills advertise. */
  $effect(() => {
    if (!shortcut || (!onDownload && !onShare)) return;

    function handleKeydown(event: KeyboardEvent): void {
      if (event.key !== 's' && event.key !== 'S') return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (downloadDisabled || encoding) return;
      // Shift routes to the share sheet; without it, the download. Each is
      // inert while its pill is absent, so the hint never lies.
      if (event.shiftKey) {
        if (!onShare) return;
        event.preventDefault();
        onShare();
        return;
      }
      if (!onDownload) return;
      event.preventDefault();
      onDownload();
    }

    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });
</script>

<section class="toolbar" aria-label="Encode settings">
  <!-- Source ------------------------------------------------------------ -->
  <div class="cell cell--source">
    <span class="mono-label">Source</span>
    <span class="filename truncate" title={fileName}>{fileName}</span>
    <span class="source-meta mono">{formatSource(originalBytes, sourceWidth, sourceHeight)}</span>
  </div>

  <!-- Encoder ----------------------------------------------------------- -->
  <div class="cell cell--encoder">
    <span class="mono-label">Encoder</span>
    <EncoderPopover
      value={settings.encoderId}
      {registry}
      {supportedEncoderIds}
      onValue={pickEncoder}
    />
  </div>

  <!-- Quality ----------------------------------------------------------- -->
  <div class="cell cell--quality">
    {#if knob.kind === 'none'}
      <span class="mono-label">{registry[settings.encoderId].label}</span>
      {#if knob.note}<span class="knob-empty mono-label mono-label--md">{knob.note}</span>{/if}
    {:else}
      <EditorialSlider
        label={knob.label}
        value={knob.value}
        valueText={knob.valueText}
        min={knob.min}
        max={knob.max}
        step={knob.step}
        ticks={knob.ticks}
        disabled={knob.disabled}
        ariaValueText={knob.ariaValueText}
        onValue={(next) => onchange(knob.apply(next))}
      >
        {#snippet accessory()}
          <span class="accessory">
            {#if knob.note}<span class="knob-note mono-label mono-label--xs">{knob.note}</span>{/if}
            {#if advanced}
              <button
                type="button"
                class="advanced-link"
                class:open={advancedOpen}
                aria-expanded={advancedOpen}
                onclick={() => onAdvancedToggle(!advancedOpen)}
              >
                Advanced {advancedOpen ? '˄' : '›'}
              </button>
            {/if}
          </span>
        {/snippet}
      </EditorialSlider>
    {/if}
  </div>

  <!-- Toggles ------------------------------------------------------------ -->
  <div class="cell cell--toggles">
    <ResizeControl {settings} {onchange} {sourceWidth} {sourceHeight} />
    <!-- Palette quantisation is not wired up yet; the switch is a placeholder. -->
    <div class="toggle-row" title="Coming soon">
      <span class="toggle-label" id="{uid}-palette">
        Palette<span class="sr-only"> — coming soon</span>
      </span>
      <EditorialToggle checked={false} labelledBy="{uid}-palette" size={34} disabled />
    </div>
  </div>

  <!-- Metrics ------------------------------------------------------------ -->
  <div class="cell cell--metrics">
    <div class="metric-row">
      <span class="mono-label mono-label--xs">SSIM</span>
      <span class="metric-value mono">{formatSsim(metrics?.ssim)}</span>
    </div>
    {#if shownVerdict}
      <span class="verdict mono-label mono-label--xs" data-tone={shownVerdict.tone}>
        {shownVerdict.label}
      </span>
    {:else}
      <span class="verdict mono-label mono-label--xs" data-tone="idle">
        {encoding ? 'Measuring…' : 'Not measured'}
      </span>
    {/if}
    {#if metricsNote}
      <span class="metric-note mono-label mono-label--xs">{metricsNote}</span>
    {/if}
  </div>

  <!-- Result + actions ---------------------------------------------------- -->
  <div class="cell cell--result">
    <div class="figures">
      {#if error}
        <span class="error mono-label mono-label--xs">{error}</span>
      {:else if outputBytes === undefined}
        <span class="figure">{encoding ? '…' : '—'}</span>
        <span class="figure-note mono">{encoding ? 'Encoding' : 'No output yet'}</span>
      {:else}
        <span class="figure">{formatBytes(outputBytes)}</span>
        <span class="savings mono">{formatSavings(originalBytes, outputBytes)}</span>
        <span class="figure-note mono">{formatDelta(originalBytes, outputBytes)}</span>
      {/if}
    </div>

    {#if onShare}
      <button
        type="button"
        class="share"
        disabled={!canDownload}
        onclick={() => onShare?.()}
      >
        <span class="share-label">Share</span>
        <span class="share-hint">⇧⌘S</span>
      </button>
    {/if}

    <button
      type="button"
      class="download"
      disabled={!canDownload}
      onclick={() => onDownload?.()}
    >
      <span class="download-label">Download</span>
      <span class="download-hint">⌘S</span>
    </button>
  </div>
</section>

<style>
  .toolbar {
    display: flex;
    align-items: stretch;
    flex: none;
    block-size: var(--h-toolbar);
    border-top: var(--border-ink);
    background: var(--paper);
  }

  .cell {
    display: flex;
    flex-direction: column;
    flex: none;
    gap: var(--space-2);
    padding: 18px 20px;
    border-right: var(--border-hairline);
    min-inline-size: 0;
  }

  .cell--source {
    inline-size: 200px;
  }

  .filename {
    font-size: var(--fs-title);
    font-weight: var(--fw-strong);
    letter-spacing: var(--tracking-tight);
  }

  .source-meta,
  .figure-note {
    font-size: var(--fs-mono-sm);
    color: var(--muted);
    white-space: nowrap;
  }

  .cell--encoder {
    gap: 10px;
  }

  .cell--quality {
    flex: 1;
    justify-content: center;
    padding-inline: 22px;
  }

  .accessory {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
  }

  .knob-note {
    color: var(--muted);
    white-space: nowrap;
  }

  .knob-empty {
    color: var(--faint);
  }

  .advanced-link {
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

  .advanced-link:hover,
  .advanced-link.open {
    color: var(--accent-blue);
  }

  .cell--toggles {
    inline-size: 160px;
    justify-content: center;
    gap: var(--space-3);
    padding-block: 14px;
  }

  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .toggle-label {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono);
    text-transform: uppercase;
    color: var(--faint);
  }

  .cell--metrics {
    inline-size: 200px;
    justify-content: center;
  }

  .metric-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .metric-value {
    font-size: var(--fs-mono-lg);
    font-weight: 700;
  }

  .verdict {
    white-space: nowrap;
    color: var(--muted);
  }

  .verdict[data-tone='good'] {
    color: var(--accent-green-dark);
  }

  .verdict[data-tone='warn'] {
    color: var(--accent-red);
  }

  .metric-note {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .cell--result {
    flex-direction: row;
    align-items: stretch;
    flex: none;
    gap: 0;
    padding: 0;
    border-right: 0;
  }

  .figures {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    justify-content: center;
    gap: 3px;
    padding: 18px 20px;
  }

  .figure {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-2xl);
    font-weight: 700;
    letter-spacing: -0.02em;
    white-space: nowrap;
  }

  .savings {
    font-size: var(--fs-mono-md);
    font-weight: 700;
    letter-spacing: var(--tracking-mono);
    color: var(--accent-green);
  }

  .error {
    max-inline-size: 200px;
    color: var(--accent-red);
    text-align: end;
    white-space: normal;
  }

  .download,
  .share {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: none;
    gap: 5px;
    border-radius: var(--radius-pill);
  }

  .download {
    inline-size: 168px;
    margin: 16px 18px 16px 0;
    border: 0;
    background: var(--ink);
    color: var(--cream);
  }

  /* Outline sibling: the share sheet is the alternative to a download, not the
     louder version of one. Narrower, because "Share" is the shorter word. */
  .share {
    inline-size: 116px;
    margin: 16px 10px 16px 0;
    border: var(--border-ink);
    background: var(--paper);
    color: var(--ink);
  }

  .download:hover:not(:disabled) {
    background: color-mix(in srgb, var(--ink) 86%, var(--paper));
  }

  .share:hover:not(:disabled) {
    background: color-mix(in srgb, var(--ink) 8%, var(--paper));
  }

  .download:disabled,
  .share:disabled {
    opacity: 0.42;
  }

  .download-label,
  .share-label {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    font-weight: 700;
    letter-spacing: var(--tracking-mono-wider);
    text-transform: uppercase;
  }

  .download-hint,
  .share-hint {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono-wide);
  }

  .download-hint {
    color: var(--cream-muted);
  }

  .share-hint {
    color: var(--muted);
  }

  /* --- Narrow desktop: wrap instead of crushing the cells ---------------- */
  @media (width <= 1100px) {
    .toolbar {
      flex-wrap: wrap;
      block-size: auto;
    }

    .cell--quality {
      flex: 1 1 260px;
    }

    .cell--result {
      flex: 1;
      justify-content: flex-end;
      border-top: var(--border-hairline);
    }

    .cell--source,
    .cell--encoder,
    .cell--toggles,
    .cell--metrics {
      flex: 1 1 auto;
    }
  }
</style>
