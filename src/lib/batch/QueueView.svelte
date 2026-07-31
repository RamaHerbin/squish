<script lang="ts">
  /**
   * Queue — "Pinch · Editorial" screen 04 (+ 06c mobile).
   *
   * One settings snapshot, many files: a stats strip, a dense table (mono
   * figures, per-row codec chip, a green saved-bar), and an ink ticker footer
   * reporting overall progress. Below 640px the table collapses into compact
   * rows and the footer becomes a sticky progress + download bar (06c).
   *
   * The batch engine (`queue.svelte.ts`, `zip.ts`, `thumbnails.ts`) is
   * untouched — this view only reads `queue` and calls its public API.
   * Encoding starts itself once files land (there is no "Compress" button in
   * the comp): an effect kicks a run whenever there is pending work and the
   * user has not explicitly hit "Stop".
   */
  import type { BatchItem, EncoderRegistry, Preset, PresetLibrary, SideSettings } from '../contracts';
  import {
    FILE_PICKER_ACCEPT,
    cloneSideSettings,
    partitionBySize,
    sideSettingsEqual,
  } from '../contracts';
  import { presetLibrary as defaultPresetLibrary } from '../presets';
  import { Chip, PillButton, Popover, StatCell, Ticker } from '../ui';
  import { ENCODER_ACCENT } from '../ui';
  import {
    clamp01,
    encoderLabel,
    formatBytes,
    formatSaved,
    qualityOf,
    savedFraction,
    splitPath,
  } from './format';
  import { acceptsDrop, messageOf, type BatchQueueStore } from './queue.svelte';
  import { createThumbnailCache, type ThumbnailCache } from './thumbnails';
  import { downloadZip } from './zip';

  interface Props {
    /** The queue store. Owns items, workers and staged outputs. */
    queue: BatchQueueStore;
    /** One settings snapshot applied to every file in the batch. */
    settings: SideSettings;
    /** Real encoder metadata, for labels and extensions. */
    registry?: EncoderRegistry;
    /** Share a cache across views; one is created here otherwise. */
    thumbnails?: ThumbnailCache;
    /** Preset library backing the Preset popover. Defaults to the shared app-wide instance. */
    library?: PresetLibrary;
    /** Called with a cloned `SideSettings` when a preset is applied. */
    onSettingsChange?: (settings: SideSettings) => void;
    /** Optional escape hatch to a full settings editor, offered inside the Preset popover. */
    onEditSettings?: () => void;
    /**
     * Shell-level PDF triage for drops this view owns. Returns true when the
     * drop was taken elsewhere (the PDF screen), in which case nothing is queued.
     * Without it a dropped PDF is silently discarded — it is not an image, so the
     * collector filters it out and the queue simply never grows.
     */
    onPdfDrop?: (files: readonly File[]) => boolean;
  }

  let {
    queue,
    settings,
    registry,
    thumbnails,
    library = defaultPresetLibrary,
    onSettingsChange,
    onEditSettings,
    onPdfDrop,
  }: Props = $props();

  /* ------------------------------------------------------------------ */
  /* Thumbnails + dimensions                                             */
  /* ------------------------------------------------------------------ */

  const ownThumbs = createThumbnailCache();
  const cache = $derived<ThumbnailCache>(thumbnails ?? ownThumbs);

  let thumbs = $state<Record<string, string>>({});
  const thumbRequested = new Set<string>();

  /** `null` once probed-and-failed, so the row falls back to the em dash. */
  let dims = $state<Record<string, { width: number; height: number } | null>>({});
  const dimsRequested = new Set<string>();

  $effect(() => {
    for (const item of queue.items) {
      if (!thumbRequested.has(item.id)) {
        thumbRequested.add(item.id);
        const { id, file } = item;
        void cache.get(id, file).then((url) => {
          if (url) thumbs[id] = url;
        });
      }
      if (!dimsRequested.has(item.id)) {
        dimsRequested.add(item.id);
        const { id, file } = item;
        void probeDimensions(file).then((size) => {
          dims[id] = size ?? null;
        });
      }
    }
  });

  // Teardown only; reads nothing, so it runs once and cleans up on destroy.
  $effect(() => () => ownThumbs.clear());

  const limitDimensionProbe = createLimiter(2);

  /**
   * Original pixel size, read via a throwaway `ImageBitmap` closed the moment
   * its dimensions are read. Kept separate from the thumbnail cache, which
   * only ever holds a *resized* bitmap and cannot answer this.
   */
  function probeDimensions(file: File): Promise<{ width: number; height: number } | undefined> {
    if (typeof createImageBitmap !== 'function') return Promise.resolve(undefined);
    return limitDimensionProbe(async () => {
      try {
        const bitmap = await createImageBitmap(file);
        const size = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return size;
      } catch {
        return undefined;
      }
    });
  }

  function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
    let active = 0;
    const waiting: Array<() => void> = [];
    const release = (): void => {
      active--;
      const next = waiting.shift();
      if (next) next();
    };
    return async <T>(task: () => Promise<T>): Promise<T> => {
      if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
      active++;
      try {
        return await task();
      } finally {
        release();
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* Progress + stats                                                    */
  /* ------------------------------------------------------------------ */

  const progress = $derived(queue.progress);
  const totalBefore = $derived(queue.items.reduce((sum, item) => sum + item.srcSize, 0));
  const processedSaved = $derived(savedFraction(progress.bytesIn, progress.bytesOut));
  const savedText = $derived(progress.done > 0 && processedSaved !== undefined ? formatSaved(processedSaved) : '—');
  const savedSoFar = $derived(Math.max(0, progress.bytesIn - progress.bytesOut));
  const overallFraction = $derived(progress.total === 0 ? 0 : (progress.done + progress.errored) / progress.total);
  const pendingCount = $derived(
    Math.max(0, progress.total - progress.done - progress.errored - progress.processing),
  );

  /** Encoder actually applied to done/processing rows — the last run's snapshot. */
  const activeEncoderId = $derived(queue.settings?.encoderId ?? settings.encoderId);

  /* ------------------------------------------------------------------ */
  /* Presets                                                             */
  /* ------------------------------------------------------------------ */

  let libraryReady = $state(false);
  $effect(() => {
    let cancelled = false;
    library.ready.then(() => {
      if (!cancelled) libraryReady = true;
    });
    return () => {
      cancelled = true;
    };
  });

  // Two independent booleans, not one shared flag: the desktop and mobile
  // Preset popovers are two separately-mounted `Popover` instances (CSS only
  // hides one of them per breakpoint, it does not unmount it), and each
  // instance runs its own focus-trap + outside-click effect while `open`.
  // Sharing one flag would leave the hidden instance "open" too, fighting the
  // visible one for focus and doubling up on document listeners.
  let presetOpenDesktop = $state(false);
  let presetOpenMobile = $state(false);
  const presetMatch = $derived(library.presets.find((preset) => sideSettingsEqual(preset.side, settings)));
  const presetSummary = $derived.by(() => {
    if (presetMatch) return presetMatch.name;
    const quality = qualityOf(settings);
    const label = encoderLabel(settings.encoderId, registry);
    return quality === undefined ? label : `${label} Q${Math.round(quality)}`;
  });

  function applyPreset(preset: Preset): void {
    onSettingsChange?.(cloneSideSettings(preset.side));
    presetOpenDesktop = false;
    presetOpenMobile = false;
  }

  function presetMeta(preset: Preset): string {
    const quality = qualityOf(preset.side);
    const label = encoderLabel(preset.side.encoderId, registry);
    return quality === undefined ? label : `${label} · Q${Math.round(quality)}`;
  }

  /* ------------------------------------------------------------------ */
  /* Adding + auto-run                                                    */
  /* ------------------------------------------------------------------ */

  let filesInput = $state<HTMLInputElement | null>(null);
  let dragging = $state(false);
  let dragDepth = 0;

  /** True once the user has explicitly hit "Stop" — suppresses the auto-run effect until they resume or add more files. */
  let manuallyStopped = $state(false);

  let sizeNote = $state<string | undefined>(undefined);

  function addFiles(list: FileList | null): void {
    if (!list || list.length === 0) return;
    const { accepted, oversized } = partitionBySize([...list]);
    sizeNote =
      oversized.length > 0
        ? `Skipped (over 50 MB): ${oversized.map((f) => f.name).join(', ')}`
        : undefined;
    if (accepted.length === 0) return;
    manuallyStopped = false;
    queue.add(accepted);
  }

  function onDragEnter(event: DragEvent): void {
    if (!acceptsDrop(event.dataTransfer)) return;
    dragDepth++;
    dragging = true;
  }

  function onDragLeave(event: DragEvent): void {
    dragDepth = event.relatedTarget === null ? 0 : Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragging = false;
  }

  function onDragOver(event: DragEvent): void {
    if (!acceptsDrop(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  async function onDrop(event: DragEvent): Promise<void> {
    if (!acceptsDrop(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth = 0;
    dragging = false;
    manuallyStopped = false;
    // Read the file list and offer it to the shell *before* the first await:
    // `DataTransfer` is neutered the moment this handler yields.
    const dropped = Array.from(event.dataTransfer?.files ?? []);
    if (dropped.length > 0 && onPdfDrop?.(dropped)) return;
    await queue.addFromDataTransfer(event.dataTransfer);
  }

  // Compression is not an action the user takes here — it is what a queue
  // does. Whenever there is pending work and nothing is running, start one,
  // unless the user just told it to stop.
  $effect(() => {
    if (manuallyStopped) return;
    if (queue.running) return;
    if (pendingCount > 0) void queue.start(settings);
  });

  function stop(): void {
    manuallyStopped = true;
    queue.cancel();
  }

  function resume(): void {
    manuallyStopped = false;
    void queue.start(settings);
  }

  function retryFailed(): void {
    manuallyStopped = false;
    queue.retryFailed();
  }

  function retryOne(id: string): void {
    manuallyStopped = false;
    queue.retry(id);
  }

  /* ------------------------------------------------------------------ */
  /* Export                                                               */
  /* ------------------------------------------------------------------ */

  let exporting = $state(false);
  let exportProgress = $state(0);
  let exportError = $state<string | undefined>(undefined);

  async function exportArchive(): Promise<void> {
    if (exporting || progress.done === 0) return;
    exporting = true;
    exportProgress = 0;
    exportError = undefined;
    try {
      await downloadZip(queue.items, {
        onProgress: (fraction) => {
          exportProgress = fraction;
        },
      });
    } catch (error) {
      exportError = messageOf(error);
    } finally {
      exporting = false;
    }
  }

  const downloadLabel = $derived(exporting ? `Exporting ${Math.round(exportProgress * 100)}%` : 'Download .zip');

  /* ------------------------------------------------------------------ */
  /* Row presentation                                                     */
  /* ------------------------------------------------------------------ */

  interface RowFacts {
    index: string;
    name: string;
    dimsText: string;
    beforeText: string;
    afterText: string;
    combinedText: string;
    savedPercentText: string;
    savedBarPct: number;
    statusText: string;
    statusColor: string;
    isError: boolean;
  }

  function rowFacts(item: BatchItem, position: number): RowFacts {
    const { name } = splitPath(item.name);
    const size = dims[item.id];
    const dimsText = size ? `${size.width} × ${size.height}` : '—';
    const done = item.status === 'done';
    const beforeText = formatBytes(item.srcSize);
    const afterText = done ? formatBytes(item.outSize ?? 0) : '—';
    const fraction = done ? savedFraction(item.srcSize, item.outSize) : undefined;
    const savedPercentText = fraction !== undefined ? formatSaved(fraction) : '—';
    const savedBarPct = fraction !== undefined ? Math.round(clamp01(fraction) * 100) : 0;

    let statusText = 'Queued';
    let statusColor = 'var(--faint)';
    if (item.status === 'processing') {
      statusText = 'Encoding';
      statusColor = 'var(--accent-blue)';
    } else if (item.status === 'done') {
      statusText = 'Done';
      statusColor = 'var(--muted)';
    } else if (item.status === 'error') {
      statusText = 'Failed';
      statusColor = 'var(--accent-red)';
    }

    return {
      index: String(position + 1).padStart(2, '0'),
      name,
      dimsText,
      beforeText,
      afterText,
      combinedText: `${beforeText} → ${afterText}`,
      savedPercentText,
      savedBarPct,
      statusText,
      statusColor,
      isError: item.status === 'error',
    };
  }
</script>

<!--
  This view is the whole page while the Queue is open, so a drop anywhere
  should land in the queue rather than navigating the tab away.
-->
<svelte:document
  ondragenter={onDragEnter}
  ondragleave={onDragLeave}
  ondragover={onDragOver}
  ondrop={onDrop}
/>

<section class="queue" aria-busy={queue.running}>
  {#if queue.items.length === 0}
    <div class="empty-wrap">
      <div class="empty-card">
        <div class="empty-dashed" aria-hidden="true"></div>
        <div class="empty-content">
          <span class="empty-icon" aria-hidden="true">+</span>
          <p class="empty-headline">Drop images here</p>
          <p class="empty-sub mono-label mono-label--md">or add a batch to compress</p>
          <PillButton variant="solid" font="body" size={44} onclick={() => filesInput?.click()}>
            Choose files
          </PillButton>
        </div>
        <span class="empty-corner left mono-label mono-label--xs">JPEG · PNG · WEBP · AVIF · SVG · GIF · PDF</span>
        <span class="empty-corner right mono-label mono-label--xs">MAX 50 MB / IMAGE · 150 MB / PDF</span>
      </div>
    </div>
  {:else}
    <!-- ---------------------------------------------------------- stats -->
    <header class="stats">
      <div class="stats-figures">
        <StatCell label="Files" value={String(progress.total)} />
        <div class="divider" aria-hidden="true"></div>
        <StatCell label="Before → after" value="{formatBytes(totalBefore)} → {formatBytes(progress.bytesOut)}" />
        <div class="divider" aria-hidden="true"></div>
        <StatCell label="Saved" value={savedText} tone={progress.done > 0 ? 'green' : 'ink'} />
      </div>
      <div class="stats-controls">
        {#if progress.errored > 0}
          <button type="button" class="retry-pill" onclick={retryFailed}>
            Retry {progress.errored} failed
          </button>
        {/if}
        {#if queue.running}
          <PillButton variant="outline" size={44} onclick={stop}>Stop</PillButton>
        {:else if manuallyStopped && pendingCount > 0}
          <PillButton variant="outline" size={44} onclick={resume}>Resume {pendingCount}</PillButton>
        {/if}

        <Popover
          open={presetOpenDesktop}
          onClose={() => (presetOpenDesktop = false)}
          placement="bottom-end"
          width="300px"
          label="Presets"
        >
          {#snippet trigger()}
            <button
              type="button"
              class="preset-trigger"
              aria-haspopup="dialog"
              aria-expanded={presetOpenDesktop}
              onclick={() => (presetOpenDesktop = !presetOpenDesktop)}
            >
              <span class="lead">Preset</span>
              <span class="value truncate">{presetSummary}</span>
              <span class="caret" aria-hidden="true">{presetOpenDesktop ? '˄' : '▾'}</span>
            </button>
          {/snippet}
          <div class="preset-panel">
            <p class="preset-heading mono-label mono-label--md">Presets</p>
            {#if !libraryReady}
              <p class="preset-empty">Loading…</p>
            {:else if library.presets.length === 0}
              <p class="preset-empty">No presets yet.</p>
            {:else}
              <ul class="preset-list">
                {#each library.presets as preset (preset.name)}
                  <li>
                    <button
                      type="button"
                      class="preset-row"
                      class:active={presetMatch?.name === preset.name}
                      onclick={() => applyPreset(preset)}
                    >
                      <span class="preset-name">{preset.name}</span>
                      <span class="preset-meta">{presetMeta(preset)}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
            {#if onEditSettings}
              <button
                type="button"
                class="preset-advanced"
                onclick={() => {
                  presetOpenDesktop = false;
                  onEditSettings?.();
                }}
              >
                Custom settings…
              </button>
            {/if}
          </div>
        </Popover>

        <PillButton variant="outline" size={44} onclick={() => filesInput?.click()}>Add files</PillButton>
        <PillButton
          variant="solid"
          size={44}
          disabled={progress.done === 0 || exporting}
          onclick={exportArchive}
        >
          {downloadLabel}
        </PillButton>
      </div>
    </header>

    {#if exportError}
      <p class="banner" role="alert">Export failed: {exportError}</p>
    {/if}
    {#if sizeNote}
      <p class="banner" role="alert">{sizeNote}</p>
    {/if}

    <!-- ------------------------------------------------------ table (desktop) -->
    <div class="table-desktop" role="table" aria-label="Queue">
      <div class="table-head" role="row">
        <div role="columnheader">#</div>
        <div role="columnheader">File</div>
        <div role="columnheader">Dimensions</div>
        <div role="columnheader">Before</div>
        <div role="columnheader">Encoder</div>
        <div role="columnheader">After</div>
        <div role="columnheader">Saved</div>
        <div role="columnheader" class="col-status">Status</div>
      </div>
      <div class="table-body">
        {#each queue.items as item, index (item.id)}
          {@const facts = rowFacts(item, index)}
          <div class="row" role="row" class:is-error={facts.isError}>
            <div role="cell" class="col-n">{facts.index}</div>
            <div role="cell" class="col-file">
              <div class="thumb" class:loaded={!!thumbs[item.id]}>
                {#if thumbs[item.id]}
                  <img src={thumbs[item.id]} alt="" loading="lazy" decoding="async" />
                {/if}
              </div>
              <div class="name truncate" title={item.name}>{facts.name}</div>
            </div>
            <div role="cell" class="col-dims mono">{facts.dimsText}</div>
            <div role="cell" class="col-before mono">{facts.beforeText}</div>
            <div role="cell" class="col-encoder">
              <Chip tone={ENCODER_ACCENT[activeEncoderId]} filled size="xs">
                {encoderLabel(activeEncoderId, registry)}
              </Chip>
            </div>
            <div role="cell" class="col-after mono">{facts.afterText}</div>
            <div role="cell" class="col-saved">
              <div class="bar-track">
                <span class="bar-fill" style="width: {facts.savedBarPct}%"></span>
              </div>
              <span class="bar-value mono">{facts.savedPercentText}</span>
            </div>
            <div role="cell" class="col-status" style="color: {facts.statusColor};">
              {#if facts.isError}
                <button type="button" class="retry-link" onclick={() => retryOne(item.id)} title={item.error}>
                  Retry
                </button>
              {:else}
                {facts.statusText}
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>

    <!-- ------------------------------------------------------- list (mobile) -->
    <div class="stats-mobile">
      <div class="mobile-figures">
        <div class="mobile-pair">
          <span class="mono-label mono-label--md">Before → after</span>
          <span class="mobile-value">{formatBytes(totalBefore)} → {formatBytes(progress.bytesOut)}</span>
        </div>
        <span class="mobile-saved">{savedText}</span>
      </div>
      <div class="mobile-preset-row">
        <div class="preset-pop">
          <Popover
            open={presetOpenMobile}
            onClose={() => (presetOpenMobile = false)}
            placement="bottom-end"
            label="Presets"
            matchWidth
          >
            {#snippet trigger()}
              <button
                type="button"
                class="preset-trigger full"
                aria-haspopup="dialog"
                aria-expanded={presetOpenMobile}
                onclick={() => (presetOpenMobile = !presetOpenMobile)}
              >
                <span class="lead">Preset</span>
                <span class="value truncate">{presetSummary}</span>
                <span class="caret" aria-hidden="true">{presetOpenMobile ? '˄' : '▾'}</span>
              </button>
            {/snippet}
          <div class="preset-panel">
            <p class="preset-heading mono-label mono-label--md">Presets</p>
            {#if !libraryReady}
              <p class="preset-empty">Loading…</p>
            {:else if library.presets.length === 0}
              <p class="preset-empty">No presets yet.</p>
            {:else}
              <ul class="preset-list">
                {#each library.presets as preset (preset.name)}
                  <li>
                    <button
                      type="button"
                      class="preset-row"
                      class:active={presetMatch?.name === preset.name}
                      onclick={() => applyPreset(preset)}
                    >
                      <span class="preset-name">{preset.name}</span>
                      <span class="preset-meta">{presetMeta(preset)}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
          </Popover>
        </div>
        <button type="button" class="add-fab" onclick={() => filesInput?.click()} aria-label="Add files">+</button>
      </div>
    </div>

    <div class="list-mobile">
      {#each queue.items as item, index (item.id)}
        {@const facts = rowFacts(item, index)}
        <div class="mrow" class:is-error={facts.isError}>
          <div class="thumb small" class:loaded={!!thumbs[item.id]}>
            {#if thumbs[item.id]}
              <img src={thumbs[item.id]} alt="" loading="lazy" decoding="async" />
            {/if}
          </div>
          <div class="mrow-meta">
            <div class="name truncate" title={item.name}>{facts.name}</div>
            <div class="sub mono">
              {facts.combinedText} · {encoderLabel(activeEncoderId, registry)}
            </div>
          </div>
          <div class="mrow-right">
            <span class="mono save">{facts.savedPercentText}</span>
            <div class="bar-track">
              <span class="bar-fill" style="width: {facts.savedBarPct}%"></span>
            </div>
            {#if facts.isError}
              <button type="button" class="retry-link" onclick={() => retryOne(item.id)}>Retry</button>
            {:else}
              <span class="status" style="color: {facts.statusColor};">{facts.statusText}</span>
            {/if}
          </div>
        </div>
      {/each}
    </div>

    <!-- --------------------------------------------------------------- footer -->
    <div class="footer-desktop">
      <Ticker variant="ink" padding="24px" live={queue.running}>
        {#snippet left()}
          <span class="tick-item">{progress.done} of {progress.total} encoded</span>
          <span class="tick-dot" style="background: var(--accent-blue);"></span>
          <span class="tick-item">{queue.concurrency} worker threads</span>
          <span class="tick-dot" style="background: var(--accent-yellow);"></span>
          <span class="tick-item">{formatBytes(savedSoFar)} saved so far</span>
          <span class="tick-dot" style="background: var(--accent-green);"></span>
        {/snippet}
        {#snippet right()}
          <div class="tick-progress">
            <div class="track">
              <span class="fill" style="width: {Math.round(overallFraction * 100)}%"></span>
            </div>
            <span>{Math.round(overallFraction * 100)}%</span>
          </div>
        {/snippet}
      </Ticker>
    </div>

    <div class="footer-mobile">
      <div class="progress-row mono-label mono-label--md">
        <div class="track">
          <span class="fill" style="width: {Math.round(overallFraction * 100)}%"></span>
        </div>
        <span>{progress.done + progress.errored} / {progress.total}</span>
      </div>
      <button
        type="button"
        class="dl-mobile"
        disabled={progress.done === 0 || exporting}
        onclick={exportArchive}
      >
        <span>{downloadLabel}</span>
        <span class="dl-size">{formatBytes(progress.bytesOut)}</span>
      </button>
    </div>
  {/if}

  {#if dragging}
    <div class="curtain" aria-hidden="true"><p>Drop to add</p></div>
  {/if}

  <input
    class="sr-only"
    type="file"
    multiple
    accept={FILE_PICKER_ACCEPT}
    bind:this={filesInput}
    onchange={(event) => {
      addFiles(event.currentTarget.files);
      event.currentTarget.value = '';
    }}
  />
</section>

<style>
  .queue {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--paper);
    color: var(--ink);
  }

  /* -------------------------------------------------------------- empty */

  .empty-wrap {
    flex: 1;
    display: flex;
    padding: var(--space-6);
  }

  .empty-card {
    position: relative;
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    border: var(--border-ink);
    border-radius: var(--radius-card);
    background: var(--surface);
    box-shadow: var(--shadow-card);
  }

  .empty-dashed {
    position: absolute;
    inset: 9px;
    border-radius: var(--radius-md);
    border: 1.5px dashed color-mix(in srgb, var(--ink) 35%, transparent);
  }

  .empty-content {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
    text-align: center;
  }

  .empty-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    background: var(--accent-blue);
    color: var(--cream);
    border: var(--border-ink);
    border-radius: var(--radius-lg);
    font-size: 24px;
    line-height: 1;
  }

  .empty-headline {
    font-size: var(--fs-h3);
    font-weight: var(--fw-strong);
    letter-spacing: var(--tracking-tight);
  }

  .empty-sub {
    margin-top: calc(-1 * var(--space-2));
  }

  .empty-corner {
    position: absolute;
    bottom: 14px;
  }

  /* Two classes to reliably outweigh the global `.mono-label` (muted) —
     the comp uses the fainter tint for these corner captions. */
  .empty-corner.mono-label {
    color: var(--faint);
  }

  .empty-corner.left {
    left: 16px;
  }

  .empty-corner.right {
    right: 16px;
  }

  /* -------------------------------------------------------------- stats */

  .stats {
    flex: none;
    height: 96px;
    display: flex;
    align-items: stretch;
    border-bottom: var(--border-ink);
  }

  .stats-figures {
    flex: 1;
    min-width: 0;
    padding: var(--space-5) var(--space-6);
    display: flex;
    align-items: center;
    gap: var(--space-7);
    overflow-x: auto;
  }

  .divider {
    width: 1px;
    align-self: stretch;
    background: var(--hairline);
    flex: none;
  }

  .stats-controls {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding-inline: var(--space-6);
  }

  .retry-pill {
    height: var(--h-control-lg);
    padding-inline: var(--space-4);
    border: 1.5px solid var(--accent-red);
    border-radius: var(--radius-pill);
    background: var(--surface);
    color: var(--accent-red);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    font-weight: 700;
    letter-spacing: var(--tracking-mono);
    text-transform: uppercase;
    white-space: nowrap;
  }

  .retry-pill:hover {
    background: color-mix(in srgb, var(--accent-red) 10%, transparent);
  }

  .banner {
    flex: none;
    padding: var(--space-3) var(--space-6);
    border-bottom: var(--border-hairline);
    background: color-mix(in srgb, var(--accent-red) 10%, var(--paper));
    color: var(--accent-red);
    font-size: var(--fs-sm);
  }

  /* ------------------------------------------------------------- preset */

  .preset-trigger {
    height: var(--h-control-lg);
    padding-inline: 18px;
    display: inline-flex;
    align-items: center;
    gap: 14px;
    border: var(--border-ink);
    border-radius: var(--radius-pill);
    background: var(--surface);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono);
    text-transform: uppercase;
    color: var(--ink);
    max-width: 260px;
  }

  .preset-trigger.full {
    max-width: none;
    width: 100%;
  }

  .preset-trigger:hover {
    background: var(--cream);
  }

  .preset-trigger .lead {
    color: var(--muted);
    flex: none;
  }

  .preset-trigger .value {
    flex: 1;
    min-width: 0;
    text-align: left;
  }

  .preset-trigger .caret {
    color: var(--muted);
    font-size: var(--fs-mono-sm);
    flex: none;
  }

  .preset-panel {
    display: flex;
    flex-direction: column;
    padding: var(--space-4);
    gap: var(--space-2);
  }

  .preset-heading {
    margin: 0 0 var(--space-1);
  }

  .preset-empty {
    margin: 0;
    padding: var(--space-3) 0;
    color: var(--muted);
    font-size: var(--fs-sm);
  }

  .preset-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 40vh;
    overflow-y: auto;
  }

  .preset-row {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: var(--space-2) var(--space-3);
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--ink);
    text-align: left;
  }

  .preset-row:hover {
    background: var(--cream);
  }

  .preset-row.active {
    background: color-mix(in srgb, var(--accent-blue) 12%, transparent);
  }

  .preset-name {
    font-size: var(--fs-sm);
    font-weight: var(--fw-strong);
    letter-spacing: var(--tracking-tight);
  }

  .preset-meta {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono-tight);
    color: var(--muted);
    text-transform: uppercase;
  }

  .preset-advanced {
    margin-top: var(--space-1);
    padding: var(--space-2) var(--space-3);
    border-top: var(--border-hairline);
    background: transparent;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono);
    text-transform: uppercase;
    text-align: left;
  }

  .preset-advanced:hover {
    color: var(--ink);
  }

  /* --------------------------------------------------------- table head */

  .table-desktop {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
  }

  .table-head {
    flex: none;
    display: grid;
    grid-template-columns: 56px 1fr 128px 100px 122px 104px 190px 152px;
    border-bottom: var(--border-hairline);
    background: var(--surface);
  }

  .table-head > div {
    padding: var(--space-3) var(--space-4);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono);
    text-transform: uppercase;
    color: var(--muted);
  }

  .table-head > div:first-child {
    padding-left: var(--space-6);
  }

  .col-status {
    text-align: right;
  }

  .table-head .col-status {
    padding-right: var(--space-6);
  }

  /* --------------------------------------------------------- table body */

  .table-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .row {
    display: grid;
    grid-template-columns: 56px 1fr 128px 100px 122px 104px 190px 152px;
    align-items: center;
    height: 62px;
    border-bottom: var(--border-faint);
  }

  .row.is-error {
    background: color-mix(in srgb, var(--accent-red) 6%, transparent);
  }

  .col-n {
    padding-left: var(--space-6);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    color: var(--faint);
  }

  .col-file {
    padding-inline: var(--space-4);
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }

  .thumb {
    flex: none;
    width: 40px;
    height: 30px;
    border: 1.5px solid var(--hairline);
    border-radius: var(--radius-thumb);
    overflow: hidden;
    background-image: repeating-linear-gradient(135deg, #e7e0cf 0 5px, var(--surface) 5px 10px);
  }

  .thumb.small {
    width: 38px;
  }

  .thumb.loaded {
    background-image: none;
  }

  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .name {
    font-size: var(--fs-body);
    letter-spacing: -0.005em;
    min-width: 0;
  }

  .col-dims,
  .col-before {
    padding-inline: var(--space-4);
    font-size: var(--fs-mono-md);
    color: var(--muted);
  }

  .col-before {
    font-size: var(--fs-xs);
    color: var(--ink);
  }

  .col-encoder {
    padding-inline: var(--space-4);
  }

  .col-after {
    padding-inline: var(--space-4);
    font-size: var(--fs-xs);
    font-weight: 700;
  }

  .col-saved {
    padding-inline: var(--space-4);
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .bar-track {
    flex: 1;
    height: 3px;
    border-radius: var(--radius-pill);
    background: var(--faint-soft);
    position: relative;
    overflow: hidden;
  }

  .bar-fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: var(--radius-pill);
    background: var(--accent-green);
  }

  .bar-value {
    flex: none;
    width: 40px;
    text-align: right;
    font-size: var(--fs-mono-md);
    font-weight: 700;
  }

  .col-status {
    padding: 0 var(--space-6) 0 var(--space-4);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono-wide);
    text-transform: uppercase;
    white-space: nowrap;
  }

  .retry-link {
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    text-decoration: underline;
  }

  /* -------------------------------------------------------------- ticker */

  .footer-desktop {
    flex: none;
  }

  .tick-item {
    white-space: nowrap;
  }

  .tick-dot {
    width: 7px;
    height: 7px;
    flex: none;
  }

  .tick-progress {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 320px;
  }

  .tick-progress .track {
    flex: 1;
    height: 4px;
    border-radius: var(--radius-pill);
    background: var(--cream-faint);
    position: relative;
    overflow: hidden;
  }

  .tick-progress .fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: var(--radius-pill);
    background: var(--accent-yellow);
  }

  /* ------------------------------------------------------------- mobile */

  .stats-mobile,
  .list-mobile,
  .footer-mobile {
    display: none;
  }

  .add-fab {
    flex: none;
    width: 44px;
    height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: var(--border-ink);
    border-radius: var(--radius-lg);
    background: var(--surface);
    color: var(--ink);
    font-size: 20px;
    line-height: 1;
  }

  @media (width <= 640px) {
    .stats,
    .table-desktop {
      display: none;
    }

    .stats-mobile {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      flex: none;
      padding: var(--space-5) var(--space-5);
      border-bottom: var(--border-ink);
    }

    .mobile-figures {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
    }

    .mobile-pair {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .mobile-value {
      font-family: var(--font-mono);
      font-size: var(--fs-mono-xl);
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .mobile-saved {
      font-family: var(--font-mono);
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--accent-green-dark);
    }

    .mobile-preset-row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }

    .preset-pop {
      flex: 1;
      min-width: 0;
    }

    .preset-pop :global(.pop-root) {
      width: 100%;
    }

    .list-mobile {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }

    .mrow {
      flex: none;
      height: 66px;
      padding-inline: var(--space-5);
      display: flex;
      align-items: center;
      gap: var(--space-3);
      border-bottom: var(--border-faint);
    }

    .mrow.is-error {
      background: color-mix(in srgb, var(--accent-red) 6%, transparent);
    }

    .mrow-meta {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .mrow-meta .sub {
      font-size: var(--fs-mono-sm);
      letter-spacing: var(--tracking-mono-tight);
      color: var(--muted);
    }

    .mrow-right {
      flex: none;
      width: 74px;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 5px;
    }

    .mrow-right .save {
      font-size: var(--fs-mono-lg);
      font-weight: 700;
    }

    /* `.bar-track`'s base `flex: 1` assumes a row context (the desktop
       table); here `.mrow-right` stacks in a column, where `flex: 1` would
       grow the track vertically instead of staying a thin horizontal bar. */
    .mrow-right .bar-track {
      flex: none;
      width: 100%;
    }

    .mrow-right .status {
      font-family: var(--font-mono);
      font-size: var(--fs-mono-xs);
      letter-spacing: var(--tracking-mono-wide);
      text-transform: uppercase;
      white-space: nowrap;
    }

    .mrow-right .retry-link {
      font-family: var(--font-mono);
      font-size: var(--fs-mono-xs);
      letter-spacing: var(--tracking-mono-wide);
      text-transform: uppercase;
      color: var(--accent-red);
    }

    .footer-desktop {
      display: none;
    }

    .footer-mobile {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      flex: none;
      padding: var(--space-4) var(--space-5) var(--space-5);
      border-top: var(--border-ink);
      background: var(--paper);
    }

    .progress-row {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .progress-row .track {
      flex: 1;
      height: 3px;
      border-radius: var(--radius-pill);
      background: var(--faint-soft);
      position: relative;
      overflow: hidden;
    }

    .progress-row .fill {
      position: absolute;
      inset: 0 auto 0 0;
      border-radius: var(--radius-pill);
      background: var(--ink);
    }

    .dl-mobile {
      height: var(--h-control-xl);
      border: var(--border-ink);
      border-radius: var(--radius-pill);
      background: var(--ink);
      color: var(--cream);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-3);
      font-family: var(--font-mono);
      font-size: var(--fs-sm);
      font-weight: 700;
      letter-spacing: var(--tracking-mono-wider);
      text-transform: uppercase;
    }

    .dl-mobile:disabled {
      opacity: 0.45;
    }

    .dl-mobile .dl-size {
      color: var(--cream-faint);
    }
  }

  /* -------------------------------------------------------------- curtain */

  .curtain {
    position: absolute;
    inset: 0;
    z-index: var(--z-overlay);
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    outline: 2px dashed var(--accent-blue);
    outline-offset: -12px;
    pointer-events: none;
  }

  .curtain p {
    font-size: var(--fs-lead);
    font-weight: 700;
    letter-spacing: var(--tracking-tight);
  }
</style>
