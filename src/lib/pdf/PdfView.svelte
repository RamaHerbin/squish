<script lang="ts">
  /**
   * The PDF screen: one document, its embedded images, and one recompression run.
   *
   * Structurally the Queue's twin (stats strip → dense table → ink ticker), and
   * for the same reason: the honest unit of this feature is the *image*, not the
   * document. A single "42% smaller" tells nobody why the other 58% stayed, so
   * every embedded image gets a row, and every row says what will happen to it
   * before the first byte is decoded — `plan.ts` is pure, so dragging the quality
   * slider or switching the DPI target repaints the whole plan column for free.
   *
   * Two things this view refuses to fake:
   *  - A refused document (encrypted, signed, unreadable) never reaches the
   *    compressor. `compressPdf` would hand back the original with no reason
   *    attached, which reads as a cheerful "0% saved" on a file we deliberately
   *    would not touch. `PdfJob` gates that; this view only ever shows the
   *    refusal sentence and the way out.
   *  - Stop is not a failure. Aborting rewinds to `ready` with no error banner.
   *
   * The job is bound to the `file` this view mounted with — mount one per file
   * (`{#key file}` upstream) rather than swapping the prop.
   */
  import { onDestroy, onMount } from 'svelte';

  import {
    PDF_DPI_PRESETS,
    PDF_MIME_TYPE,
    PDF_QUALITY_RANGE,
    pdfSkipLabel,
    type PdfCompressSettings,
    type PdfImageInfo,
    type PdfImageOutcome,
  } from '../contracts';
  import { formatBytes, formatSavings, formatSsim } from '../options';
  import { saveBlob } from '../platform';
  import {
    Chip,
    EditorialCheckbox,
    EditorialSlider,
    EditorialToggle,
    PillButton,
    StatCell,
    Ticker,
  } from '../ui';

  import { createPdfJob } from './pdf-job.svelte';
  import { imageSkipReason, resampleTarget } from './plan';

  interface Props {
    /** The document to read. Analysis starts on mount. */
    file: File;
    /** Leave the PDF view — the only exit from a refused document. */
    onclose: () => void;
  }

  let { file, onclose }: Props = $props();

  // Deliberate initial-value capture: the job owns the document it analysed.
  // Mount a new view (`{#key file}`) for a new file rather than swapping the prop.
  // svelte-ignore state_referenced_locally
  const job = createPdfJob(file);

  onMount(() => {
    void job.analyze();
  });
  onDestroy(() => job.dispose());

  /* ------------------------------------------------------------------ */
  /* Derived                                                             */
  /* ------------------------------------------------------------------ */

  const analysis = $derived(job.analysis);
  const settings = $derived(job.settings);
  const result = $derived(job.result);
  const railDisabled = $derived(job.phase === 'compressing');
  const canCompress = $derived(job.phase === 'ready' || job.phase === 'done');

  /** A refusal and a dead analysis are the same screen: a sentence and an exit. */
  const blocked = $derived(job.phase === 'refused' || (job.phase === 'error' && !analysis));

  const images = $derived<readonly PdfImageInfo[]>(analysis?.images ?? []);

  /** Outcomes by ref, so the analysis table can grow three columns when done. */
  const outcomes = $derived.by(() => {
    const byRef = new Map<string, PdfImageOutcome>();
    for (const outcome of result?.images ?? []) byRef.set(outcome.ref, outcome);
    return byRef;
  });

  const stem = $derived(file.name.replace(/\.pdf$/i, '') || 'document');

  /**
   * Read off the outcomes, not off `settings.measure` — the rail stays live in
   * `done`, and the SSIM column belongs to the run that produced the numbers.
   */
  const measured = $derived([...outcomes.values()].some((outcome) => outcome.ssim !== undefined));

  /* ------------------------------------------------------------------ */
  /* Settings rail                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Settings are replaced wholesale, never mutated: the contract's fields are
   * `readonly`, and a run holds its own snapshot anyway.
   */
  function patch(next: Partial<PdfCompressSettings>): void {
    job.settings = { ...job.settings, ...next };
  }

  /* ------------------------------------------------------------------ */
  /* Row presentation                                                    */
  /* ------------------------------------------------------------------ */

  interface Plan {
    text: string;
    /** True for "we are leaving this alone", which is muted, not a warning. */
    skip: boolean;
  }

  /**
   * What the current rail would do to one image — the same two pure functions
   * the orchestrator calls, so the column cannot drift from the run.
   */
  function planFor(info: PdfImageInfo, current: PdfCompressSettings): Plan {
    const reason = imageSkipReason(info, current);
    if (reason) return { text: pdfSkipLabel(reason), skip: true };
    const target = resampleTarget(info, current);
    return {
      text: target ? `→ ${target.width} × ${target.height}` : 'recompress',
      skip: false,
    };
  }

  /** 1-based page numbers, as printed on the page itself. */
  function formatPages(pageIndices: readonly number[]): string {
    if (pageIndices.length === 0) return '—';
    const shown = pageIndices.slice(0, 3).map((index) => index + 1);
    const rest = pageIndices.length - shown.length;
    return rest > 0 ? `${shown.join(', ')} +${rest}` : shown.join(', ');
  }

  /** The filter's accent: the two we can recompress read as live, the rest muted. */
  function filterTone(info: PdfImageInfo): string {
    if (info.filter === 'DCTDecode') return 'red';
    if (info.filter === 'FlateDecode') return 'blue';
    return 'muted';
  }

  function outText(outcome: PdfImageOutcome | undefined): string {
    if (!outcome) return '—';
    if (outcome.outBytes === undefined) {
      return outcome.skipped ? pdfSkipLabel(outcome.skipped) : '—';
    }
    return formatBytes(outcome.outBytes);
  }

  function savedText(outcome: PdfImageOutcome | undefined): string {
    if (!outcome || outcome.outBytes === undefined) return '—';
    return formatSavings(outcome.srcBytes, outcome.outBytes);
  }

  /* ------------------------------------------------------------------ */
  /* Actions                                                             */
  /* ------------------------------------------------------------------ */

  function toggleRun(): void {
    if (job.running) job.abort();
    else void job.compress();
  }

  let saveError = $state<string | undefined>(undefined);

  async function download(): Promise<void> {
    const done = job.result;
    if (!done) return;
    saveError = undefined;
    try {
      await saveBlob(`${stem}-compressed.pdf`, new Blob([done.bytes], { type: PDF_MIME_TYPE }));
    } catch (error) {
      saveError = error instanceof Error ? error.message : 'Could not save the file.';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Ticker copy                                                         */
  /* ------------------------------------------------------------------ */

  const tickerText = $derived.by(() => {
    if (job.phase === 'compressing') {
      return `Image ${job.progress.done} / ${job.progress.total}`;
    }
    if (result) {
      return `${formatBytes(result.srcBytes)} → ${formatBytes(result.outBytes)} · ${formatSavings(result.srcBytes, result.outBytes)} · ${result.replaced} replaced · ${result.deduped} deduped · ${result.ms} ms`;
    }
    if (job.phase === 'analyzing') return 'Reading document…';
    if (analysis) {
      return `${analysis.images.length} images · ${formatBytes(analysis.imageBytes)} in image streams`;
    }
    return 'PDF';
  });

  const percent = $derived(
    job.progress.total === 0 ? 0 : Math.round((job.progress.done / job.progress.total) * 100),
  );
</script>

<section class="pdf" data-view="pdf" aria-busy={job.running}>
  {#if blocked}
    <!-- ------------------------------------------------------- refused -->
    <div class="blocked">
      <div class="blocked-card">
        <span class="mono-label mono-label--md">{job.phase === 'refused' ? 'Refused' : 'Failed'}</span>
        <p class="blocked-message">{job.error ?? 'This PDF could not be read.'}</p>
        <p class="blocked-file mono truncate" title={file.name}>{file.name}</p>
        <div class="blocked-actions">
          {#if job.phase === 'error'}
            <PillButton variant="outline" size={44} onclick={() => void job.analyze()}>
              Try again
            </PillButton>
          {/if}
          <PillButton variant="solid" size={44} onclick={onclose}>Choose another file</PillButton>
        </div>
      </div>
    </div>
  {:else}
    <!-- --------------------------------------------------------- stats -->
    <header class="stats">
      <div class="stats-figures">
        <StatCell label="Pages" value={analysis ? String(analysis.pageCount) : '—'} />
        <div class="divider" aria-hidden="true"></div>
        <StatCell label="File size" value={formatBytes(file.size)} />
        <div class="divider" aria-hidden="true"></div>
        <StatCell label="Images found" value={analysis ? String(images.length) : '—'} />
        <div class="divider" aria-hidden="true"></div>
        <StatCell label="Image bytes" value={analysis ? formatBytes(analysis.imageBytes) : '—'} />
      </div>
      <div class="stats-end">
        <span class="file-name mono truncate" title={file.name}>{file.name}</span>
        <button type="button" class="close" onclick={onclose}>Close</button>
      </div>
    </header>

    {#if job.phase === 'error' && job.error}
      <p class="banner" role="alert">{job.error}</p>
    {/if}
    {#if saveError}
      <p class="banner" role="alert">{saveError}</p>
    {/if}

    <!-- ---------------------------------------------------------- rail -->
    {#if canCompress || railDisabled}
      <div class="rail" class:is-disabled={railDisabled}>
        <div class="rail-quality">
          <EditorialSlider
            value={settings.imageQuality}
            min={PDF_QUALITY_RANGE.min}
            max={PDF_QUALITY_RANGE.max}
            step={PDF_QUALITY_RANGE.step}
            label="Image quality"
            disabled={railDisabled}
            onValue={(value) => patch({ imageQuality: value })}
            ariaValueText="MozJPEG quality {settings.imageQuality}"
          />
        </div>

        <div class="rail-dpi">
          <span class="mono-label" id="pdf-dpi-label">Target DPI</span>
          <div class="segments" role="group" aria-labelledby="pdf-dpi-label">
            <button
              type="button"
              class="segment"
              class:on={settings.targetDpi === null}
              aria-pressed={settings.targetDpi === null}
              disabled={railDisabled}
              onclick={() => patch({ targetDpi: null })}
            >
              Keep
            </button>
            {#each PDF_DPI_PRESETS as dpi (dpi)}
              <button
                type="button"
                class="segment"
                class:on={settings.targetDpi === dpi}
                aria-pressed={settings.targetDpi === dpi}
                disabled={railDisabled}
                onclick={() => patch({ targetDpi: dpi })}
              >
                {dpi}
              </button>
            {/each}
          </div>
        </div>

        <div class="rail-switches">
          <div class="switch">
            <span class="switch-title">Flate → JPEG</span>
            <EditorialToggle
              checked={settings.flateToJpeg}
              label="Flate → JPEG"
              size={34}
              disabled={railDisabled}
              onValue={(value) => patch({ flateToJpeg: value })}
            />
          </div>
          <div class="switch">
            <span class="switch-title">Dedupe identical images</span>
            <EditorialToggle
              checked={settings.dedupeImages}
              label="Dedupe identical images"
              size={34}
              disabled={railDisabled}
              onValue={(value) => patch({ dedupeImages: value })}
            />
          </div>
          <div class="switch">
            <span class="switch-title">Strip metadata</span>
            <EditorialToggle
              checked={settings.stripMetadata}
              label="Strip metadata"
              size={34}
              disabled={railDisabled}
              onValue={(value) => patch({ stripMetadata: value })}
            />
          </div>
          <div class="switch measure">
            <EditorialCheckbox
              checked={settings.measure}
              label="Measure SSIM (slower)"
              hint="A second decode per replaced image."
              disabled={railDisabled}
              onValue={(value) => patch({ measure: value })}
            />
          </div>
        </div>
      </div>
    {/if}

    <!-- --------------------------------------------------------- table -->
    <div class="table-wrap">
      <table class="pdf-images">
        <caption class="sr-only">Embedded images</caption>
        <thead>
          <tr>
            <th scope="col" class="col-ref">Object</th>
            <th scope="col" class="col-pages">Pages</th>
            <th scope="col" class="col-size">Pixels</th>
            <th scope="col" class="col-filter">Filter</th>
            <th scope="col" class="col-bytes">Stored</th>
            <th scope="col" class="col-dpi">DPI</th>
            <th scope="col" class="col-plan">Plan</th>
            {#if result}
              <th scope="col" class="col-out">Out</th>
              <th scope="col" class="col-saved">Saved</th>
              {#if measured}<th scope="col" class="col-ssim">SSIM</th>{/if}
            {/if}
          </tr>
        </thead>
        <tbody>
          {#each images as info (info.ref)}
            {@const plan = planFor(info, settings)}
            {@const outcome = outcomes.get(info.ref)}
            <tr>
              <td class="col-ref mono">{info.ref}</td>
              <td class="col-pages mono">{formatPages(info.pageIndices)}</td>
              <td class="col-size mono">{info.width} × {info.height}</td>
              <td class="col-filter">
                <Chip tone={filterTone(info)} size="xs">{info.filter}</Chip>
              </td>
              <td class="col-bytes mono">{formatBytes(info.srcBytes)}</td>
              <td class="col-dpi mono">{info.effectiveDpi === undefined ? '—' : Math.round(info.effectiveDpi)}</td>
              <td class="col-plan mono" class:is-skip={plan.skip}>{plan.text}</td>
              {#if result}
                <td class="col-out mono">{outText(outcome)}</td>
                <td class="col-saved mono">{savedText(outcome)}</td>
                {#if measured}
                  <td class="col-ssim mono">
                    {outcome && outcome.ssim !== undefined ? formatSsim(outcome.ssim) : '—'}
                  </td>
                {/if}
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>

      {#if images.length === 0}
        <p class="table-empty">
          {job.phase === 'analyzing'
            ? 'Reading the document…'
            : 'No embedded images. Stripping metadata is all there is to win here.'}
        </p>
      {/if}
    </div>

    <!-- -------------------------------------------------------- actions -->
    <div class="actions">
      <PillButton
        variant="solid"
        size={52}
        disabled={!canCompress && !job.running}
        onclick={toggleRun}
      >
        {job.running ? 'Stop' : 'Compress'}
      </PillButton>

      <button type="button" class="download" disabled={!result} onclick={() => void download()}>
        <span>Download PDF</span>
        {#if result}<span class="download-size mono">{formatBytes(result.outBytes)}</span>{/if}
      </button>
    </div>

    <!-- -------------------------------------------------------- results -->
    {#if result}
      {@const done = result}
      <div class="pdf-result">
        <div class="result-figures">
          <div class="result-out">
            <span class="mono-label mono-label--md">Output</span>
            <span class="figure">{formatBytes(done.outBytes)}</span>
          </div>
          <div class="divider" aria-hidden="true"></div>
          <StatCell
            label="Saved"
            value={formatSavings(done.srcBytes, done.outBytes)}
            hint="from {formatBytes(done.srcBytes)}"
            tone={done.outBytes < done.srcBytes ? 'green' : 'ink'}
          />
          <div class="divider" aria-hidden="true"></div>
          <StatCell label="Replaced" value={`${done.replaced} / ${images.length}`} size="md" />
          <div class="divider" aria-hidden="true"></div>
          <StatCell label="Deduped" value={String(done.deduped)} size="md" />
          <div class="divider" aria-hidden="true"></div>
          <StatCell label="Took" value={`${done.ms} ms`} size="md" />
        </div>
        {#if done.outBytes >= done.srcBytes}
          <p class="result-note">Already tight — nothing worth replacing</p>
        {/if}
      </div>
    {/if}

    <!-- --------------------------------------------------------- ticker -->
    <div class="footer">
      <Ticker variant="ink" padding="24px" live={job.running}>
        {#snippet left()}
          <span class="tick-item">{tickerText}</span>
        {/snippet}
        {#snippet right()}
          {#if job.phase === 'compressing'}
            <div class="tick-progress">
              <div class="track">
                <span class="fill" style="width: {percent}%"></span>
              </div>
              <span>{percent}%</span>
            </div>
          {/if}
        {/snippet}
      </Ticker>
    </div>
  {/if}
</section>

<style>
  .pdf {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--paper);
    color: var(--ink);
  }

  /* ------------------------------------------------------------ blocked */

  .blocked {
    flex: 1;
    display: flex;
    padding: var(--space-6);
  }

  .blocked-card {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-4);
    padding: var(--space-7);
    text-align: center;
    border: var(--border-ink);
    border-radius: var(--radius-card);
    background: var(--surface);
    box-shadow: var(--shadow-card);
  }

  .blocked-message {
    max-width: 46ch;
    font-size: var(--fs-h3);
    font-weight: var(--fw-strong);
    letter-spacing: var(--tracking-h3);
  }

  .blocked-file {
    max-width: 100%;
    font-size: var(--fs-mono-md);
    color: var(--muted);
  }

  .blocked-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-3);
  }

  /* -------------------------------------------------------------- stats */

  .stats {
    flex: none;
    display: flex;
    align-items: stretch;
    border-bottom: var(--border-ink);
  }

  .stats-figures {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-7);
    padding: var(--space-5) var(--space-6);
    overflow-x: auto;
  }

  .divider {
    flex: none;
    width: 1px;
    align-self: stretch;
    background: var(--hairline);
  }

  .stats-end {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--space-4);
    max-width: 34%;
    padding-inline: var(--space-6);
  }

  .file-name {
    font-size: var(--fs-mono-md);
    color: var(--muted);
  }

  .close {
    flex: none;
    height: var(--h-control);
    padding-inline: var(--space-4);
    border: var(--border-hairline);
    border-radius: var(--radius-pill);
    background: var(--surface);
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono);
    text-transform: uppercase;
  }

  .close:hover {
    color: var(--ink);
    background: var(--cream);
  }

  .banner {
    flex: none;
    padding: var(--space-3) var(--space-6);
    border-bottom: var(--border-hairline);
    background: color-mix(in srgb, var(--accent-red) 10%, var(--paper));
    color: var(--accent-red);
    font-size: var(--fs-sm);
  }

  /* --------------------------------------------------------------- rail */

  .rail {
    flex: none;
    display: grid;
    grid-template-columns: minmax(220px, 1fr) minmax(240px, auto) minmax(260px, 1.1fr);
    align-items: start;
    gap: var(--space-6) var(--space-7);
    padding: var(--space-5) var(--space-6);
    border-bottom: var(--border-hairline);
    background: var(--surface);
  }

  .rail.is-disabled {
    /* The controls carry their own disabled state; this is the whole-rail cue. */
    color: var(--muted);
  }

  .rail-dpi {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .segments {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .segment {
    height: var(--h-control);
    padding-inline: var(--space-4);
    border: var(--border-hairline);
    border-radius: var(--radius-pill);
    background: var(--surface);
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    font-weight: 700;
    letter-spacing: var(--tracking-mono);
    text-transform: uppercase;
  }

  .segment:hover:not(:disabled) {
    background: var(--cream);
    color: var(--ink);
  }

  .segment.on {
    border: var(--border-ink);
    background: var(--ink);
    color: var(--cream);
  }

  .segment:disabled {
    opacity: 0.45;
  }

  .rail-switches {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .switch {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-5);
  }

  .switch-title {
    font-size: var(--fs-sm);
    letter-spacing: var(--tracking-tight);
  }

  .measure {
    padding-top: var(--space-2);
    border-top: var(--border-faint);
  }

  /* -------------------------------------------------------------- table */

  .table-wrap {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .pdf-images {
    width: 100%;
    border-collapse: collapse;
  }

  .pdf-images th {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: var(--space-3) var(--space-4);
    border-bottom: var(--border-hairline);
    background: var(--surface);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    font-weight: 400;
    letter-spacing: var(--tracking-mono);
    text-transform: uppercase;
    color: var(--muted);
    text-align: left;
    white-space: nowrap;
  }

  .pdf-images td {
    padding: var(--space-3) var(--space-4);
    border-bottom: var(--border-faint);
    font-size: var(--fs-mono-md);
    white-space: nowrap;
  }

  .pdf-images th:first-child,
  .pdf-images td:first-child {
    padding-left: var(--space-6);
  }

  .pdf-images th:last-child,
  .pdf-images td:last-child {
    padding-right: var(--space-6);
  }

  .col-ref {
    color: var(--faint);
  }

  .col-plan {
    font-weight: 700;
  }

  .col-plan.is-skip {
    font-weight: 400;
    color: var(--muted);
  }

  .col-out {
    font-weight: 700;
  }

  .col-saved {
    color: var(--accent-green-dark);
  }

  .table-empty {
    padding: var(--space-6);
    color: var(--muted);
    font-size: var(--fs-sm);
  }

  /* ------------------------------------------------------------ actions */

  .actions {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-6);
    border-top: var(--border-hairline);
  }

  /*
    Hand-rolled rather than a `PillButton`: the E2E contract pins the download
    trigger to `button.download`, and the primitive owns its own class list.
    Same solid-pill treatment, same tokens.
  */
  .download {
    height: var(--h-control-xl);
    padding-inline: var(--space-6);
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    border: var(--border-ink);
    border-radius: var(--radius-pill);
    background: var(--ink);
    color: var(--cream);
    box-shadow: var(--shadow-button);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .download:hover:not(:disabled) {
    background: color-mix(in srgb, var(--ink) 86%, var(--paper));
  }

  .download:disabled {
    opacity: 0.42;
    box-shadow: none;
  }

  .download-size {
    color: var(--cream-faint);
  }

  /* ------------------------------------------------------------- result */

  .pdf-result {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-5) var(--space-6);
    border-top: var(--border-hairline);
    background: var(--surface);
  }

  .result-figures {
    display: flex;
    align-items: center;
    gap: var(--space-6);
    overflow-x: auto;
  }

  .result-out {
    display: flex;
    flex-direction: column;
    gap: 5px;
    flex: none;
  }

  .figure {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-2xl);
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .result-note {
    color: var(--muted);
    font-size: var(--fs-sm);
  }

  /* ------------------------------------------------------------- ticker */

  .footer {
    flex: none;
  }

  .tick-item {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tick-progress {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 220px;
  }

  .tick-progress .track {
    position: relative;
    flex: 1;
    height: 4px;
    border-radius: var(--radius-pill);
    background: var(--cream-faint);
    overflow: hidden;
  }

  .tick-progress .fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: var(--radius-pill);
    background: var(--accent-yellow);
  }

  /* ------------------------------------------------------------- mobile */

  @media (width <= 640px) {
    .stats-figures {
      gap: var(--space-5);
      padding: var(--space-4) var(--space-5);
    }

    .stats-end {
      max-width: none;
      padding-inline: var(--space-5);
    }

    .file-name {
      display: none;
    }

    .rail {
      grid-template-columns: 1fr;
      gap: var(--space-5);
      padding: var(--space-4) var(--space-5);
    }

    /* The document-level columns survive; the object-level detail does not. */
    .col-ref,
    .col-filter,
    .col-dpi {
      display: none;
    }

    .pdf-images th,
    .pdf-images td {
      padding: var(--space-3) var(--space-3);
    }

    .pdf-images th:first-child,
    .pdf-images td:first-child {
      padding-left: var(--space-5);
    }

    .pdf-images th:last-child,
    .pdf-images td:last-child {
      padding-right: var(--space-5);
    }

    .actions {
      flex-direction: column;
      align-items: stretch;
      padding: var(--space-4) var(--space-5);
    }

    .download {
      justify-content: center;
    }

    .pdf-result {
      padding: var(--space-4) var(--space-5);
    }
  }
</style>
