<script lang="ts">
  /**
   * Screen 03 — the codec matrix.
   *
   * One image, every wasm encoder, four steps each: weight, savings, SSIM and
   * a verdict per cell, with the recommended cell flagged in blue. The top bar
   * (PINCH / file name / close) belongs to the shell — this component renders
   * the view body only.
   *
   * The explainer copy is generated from the sweep rather than written into
   * the markup, so it always names the encoders that actually ran, says out
   * loud that OxiPNG's columns are effort levels, and lists what sat out.
   *
   * Every data cell is a button: clicking one applies that exact
   * `SideSettings` to the editor through `onapply`.
   */
  import { untrack } from 'svelte';
  import { BrandDot, Chip, PillButton } from '../ui';
  import type { AccentName } from '../ui';
  import { ENCODER_REGISTRY, createDefaultWorkerBridge } from '../codecs';
  import type {
    CreateWorkerBridge,
    EncoderId,
    EncoderRegistry,
    SideSettings,
    VerdictTone,
  } from '../contracts';
  import {
    MATRIX_EFFORT_STEPS,
    UNMEASURED_QUALITY_FLOOR,
    barPercent,
    createMatrixSweep,
    type MatrixMetricsFn,
    type MatrixSweepCell,
    type MatrixSweepRow,
  } from './sweep.svelte';
  import {
    describeSweep,
    formatBytes,
    formatSavedPct,
    formatSeconds,
    formatSsim,
    numberWord,
    stepShortLabel,
  } from './format';

  interface Props {
    /**
     * Decoded source pixels — `session.state.source?.decoded`. The sweep
     * restarts whenever this changes identity.
     */
    source?: ImageData | undefined;
    /** Size of the source file, for the savings column. */
    originalBytes?: number;
    /** One worker per lane. Defaults to the real codec worker bridge. */
    createBridge?: CreateWorkerBridge;
    /** Encoder metadata. Defaults to the real `ENCODER_REGISTRY`. */
    registry?: EncoderRegistry;
    /** Rows. Defaults to the contract's `MATRIX_ENCODERS`. */
    encoders?: readonly EncoderId[];
    /** Columns. Defaults to the contract's `MATRIX_QUALITY_STEPS`. */
    qualities?: readonly number[];
    /** Columns for lossless rows. */
    efforts?: readonly number[];
    /** `AppSettings.workerThreads`. Read at every run, so changes take effect. */
    threads?: number;
    /**
     * Perceptual metric. Captured when the view mounts — pass a stable
     * function. Absent ⇒ every SSIM reads "—" and the copy says so.
     */
    metrics?: MatrixMetricsFn;
    /** Start sweeping as soon as a source is available. */
    auto?: boolean;
    /** Apply one cell's settings to the editor. */
    onapply?: (settings: SideSettings) => void;
    /** "Open in editor" — the shell switches views. */
    onopen?: () => void;
  }

  let {
    source = undefined,
    originalBytes = 0,
    createBridge = createDefaultWorkerBridge,
    registry = ENCODER_REGISTRY,
    encoders,
    qualities,
    efforts = MATRIX_EFFORT_STEPS,
    threads,
    metrics,
    auto = true,
    onapply,
    onopen,
  }: Props = $props();

  /**
   * The sweep's shape (bridge factory, registry, rows, columns, metric) is
   * configuration, read once when the view mounts — `untrack` says so rather
   * than pretending a later change would rebuild the table. The two things
   * that *do* change, thread count and measure-or-not, are passed per run.
   */
  const sweep = untrack(() =>
    createMatrixSweep({
      createBridge,
      registry,
      encoders,
      qualities,
      efforts,
      concurrency: threads,
      metrics,
    }),
  );

  /** The `ImageData` the current table belongs to; guards the auto-run effect. */
  let sweptSource: ImageData | undefined = undefined;

  function startSweep(): void {
    if (!source) return;
    sweptSource = source;
    void sweep.run(source, originalBytes, {
      concurrency: threads,
      measure: metrics !== undefined,
    });
  }

  $effect(() => {
    const next = source;
    if (!auto || !next || sweptSource === next) return;
    startSweep();
  });

  $effect(() => () => sweep.dispose());

  const measured = $derived(metrics !== undefined);

  const explainer = $derived(
    describeSweep({
      lossyLabels: sweep.rows.filter((row) => !row.lossless).map((row) => row.label),
      losslessLabels: sweep.rows.filter((row) => row.lossless).map((row) => row.label),
      efforts,
      columnCount: sweep.columns.length,
      excludedLabels: sweep.excludedLabels,
      measured,
      unmeasuredFloor: UNMEASURED_QUALITY_FLOOR,
    }),
  );

  const headline = $derived(`${numberWord(sweep.totalEncodes)} encodes, one look.`);

  const status = $derived.by(() => {
    const total = sweep.totalEncodes;
    const done = sweep.completedEncodes;
    const seconds = formatSeconds(sweep.elapsedMs);
    const threadWord = `${sweep.threads} thread${sweep.threads === 1 ? '' : 's'}`;
    if (sweep.running) return `${done}/${total} encodes · ${seconds} s on ${threadWord}`;
    if (sweep.completedEncodes + sweep.failedEncodes === 0) {
      return source ? `${total} encodes queued · ready` : 'No image open';
    }
    const failedNote = sweep.failedEncodes > 0 ? ` · ${sweep.failedEncodes} failed` : '';
    return `${done} encodes · ${seconds} s on ${threadWord}${failedNote}`;
  });

  const applyLabel = $derived.by(() => {
    const row = sweep.recommendedRow;
    const cell = sweep.recommended;
    if (!row || !cell) return 'Use recommended';
    return `Use ${row.label} ${stepShortLabel(cell.step, row.lossless)}`;
  });

  function verdictTone(tone: VerdictTone): AccentName {
    if (tone === 'good') return 'green';
    if (tone === 'warn') return 'red';
    return 'muted';
  }

  function apply(rowIndex: number, cellIndex: number): void {
    const settings = sweep.settingsAt(rowIndex, cellIndex);
    if (settings) onapply?.(settings);
  }

  function applyRecommended(): void {
    const settings = sweep.recommendedSettings;
    if (settings) onapply?.(settings);
  }

  function describeCell(row: MatrixSweepRow, cell: MatrixSweepCell): string {
    const head = `${row.label} ${cell.stepLabel}`;
    if (cell.status === 'error') return `${head} — failed: ${cell.error ?? 'unknown error'}`;
    if (cell.status !== 'done') return `${head} — not encoded yet`;
    const ssim = measured ? `, SSIM ${formatSsim(cell.ssim)}` : '';
    return `${head} — ${formatBytes(cell.size)}, ${formatSavedPct(
      cell.savedPct,
    )} versus the original${ssim} (${cell.verdict.label}). Apply to the editor.`;
  }
</script>

<section class="matrix">
  <header class="head">
    <div class="head-text">
      <h1 class="headline">{headline}</h1>
      <p class="explainer">{explainer}</p>
    </div>
    <p class="legend mono-label">
      <BrandDot accent="blue" size={13} />
      <span>Recommended</span>
    </p>
  </header>

  <div class="table-wrap scroll-x">
    <table class="matrix-table">
      <caption class="sr-only">
        Encoded size, saving against the original{measured ? ', SSIM' : ''} and a verdict for
        every encoder at every step. Activate a cell to apply its settings.
      </caption>
      <thead>
        <tr>
          <th scope="col" class="col-encoder">Encoder</th>
          {#each sweep.columns as column (column.index)}
            <th scope="col" title="Quality {column.quality} · effort {column.effort} on lossless rows">
              {column.label}
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each sweep.rows as row, rowIndex (row.encoderId)}
          <tr>
            <th scope="row" class="col-encoder">
              <span class="row-head">
                <span class="row-name">
                  <span
                    class="badge"
                    class:badge-ink={row.darkBadgeText}
                    style="--badge-fill: {row.accent};"
                    aria-hidden="true">{row.initial}</span
                  >
                  <span class="codec">{row.label}</span>
                </span>
                {#if row.note}<span class="note">{row.note}</span>{/if}
              </span>
            </th>

            {#each row.cells as cell, cellIndex (cell.column)}
              <td class="cell" class:recommended={cell.recommended}>
                <button
                  type="button"
                  class="cell-button"
                  disabled={cell.status !== 'done'}
                  title={describeCell(row, cell)}
                  aria-label={describeCell(row, cell)}
                  onclick={() => apply(rowIndex, cellIndex)}
                >
                  <span class="figures">
                    {#if cell.status === 'done'}
                      <span class="size">{formatBytes(cell.size)}</span>
                      <span class="saved">{formatSavedPct(cell.savedPct)}</span>
                    {:else if cell.status === 'error'}
                      <span class="size faded">—</span>
                      <span class="saved">failed</span>
                    {:else}
                      <span class="size faded" class:pulsing={cell.status === 'running'}>…</span>
                    {/if}
                  </span>

                  <span class="bar">
                    <span class="bar-fill" style="inline-size: {barPercent(row, cell)}%"></span>
                  </span>

                  <span class="foot">
                    <span class="ssim">SSIM {formatSsim(cell.ssim)}</span>
                    {#if cell.status === 'done' || cell.status === 'error'}
                      <Chip tone={verdictTone(cell.verdict.tone)} size="xs" uppercase={false}>
                        {cell.verdict.label}
                      </Chip>
                    {/if}
                  </span>
                </button>
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <footer class="foot-bar">
    <div class="foot-left">
      <p class="status" role="status" aria-live="polite">{status}</p>
      {#if sweep.running}
        <PillButton variant="outline" size={38} onclick={() => sweep.cancel()}>Cancel</PillButton>
      {:else}
        <PillButton variant="outline" size={38} disabled={!source} onclick={startSweep}>
          {sweep.done || sweep.failedEncodes > 0 ? 'Re-run' : 'Run sweep'}
        </PillButton>
      {/if}
      {#if sweep.error}
        <p class="sweep-error mono">{sweep.error}</p>
      {/if}
    </div>

    <div class="actions">
      <PillButton variant="outline" size={44} onclick={() => onopen?.()}>
        Open in editor
      </PillButton>
      <PillButton
        variant="solid"
        size={44}
        disabled={!sweep.recommended}
        onclick={applyRecommended}
      >
        {applyLabel}
      </PillButton>
    </div>
  </footer>
</section>

<style>
  /* 44px / 48px padding and a 28px rhythm, straight off the 1440×900 comp. */
  .matrix {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 28px;
    padding: var(--space-8) 48px;
    background: var(--paper);
    color: var(--ink);
    block-size: 100%;
    min-block-size: 0;
    overflow-y: auto;
  }

  /* -- head ------------------------------------------------------------- */

  .head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-6);
  }

  .head-text {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .headline {
    margin: 0;
    font-size: var(--fs-h1);
    font-weight: var(--fw-heading);
    letter-spacing: var(--tracking-h1);
    line-height: 1;
  }

  .explainer {
    margin: 0;
    max-inline-size: 560px;
    font-size: var(--fs-body);
    color: var(--muted);
    text-wrap: pretty;
  }

  .legend {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-3);
    margin: 0;
    letter-spacing: var(--tracking-mono-wide);
  }

  /* -- table ------------------------------------------------------------ */

  .table-wrap {
    border: var(--border-ink);
    border-radius: var(--radius-lg);
    background: var(--paper);
  }

  .matrix-table {
    inline-size: 100%;
    min-inline-size: 760px;
    border-collapse: collapse;
    table-layout: fixed;
  }

  .matrix-table th,
  .matrix-table td {
    text-align: start;
    vertical-align: top;
    border-inline-end: var(--border-hairline);
  }

  .matrix-table th:last-child,
  .matrix-table td:last-child {
    border-inline-end: 0;
  }

  .col-encoder {
    inline-size: 232px;
  }

  thead th {
    padding: 14px 18px;
    background: var(--surface);
    border-block-end: var(--border-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    font-weight: 400;
    letter-spacing: var(--tracking-mono-wider);
    text-transform: uppercase;
    color: var(--muted);
  }

  tbody tr {
    border-block-end: var(--border-hairline);
  }

  tbody tr:last-child {
    border-block-end: 0;
  }

  tbody th {
    padding: 14px 18px;
    font-weight: 400;
  }

  .row-head {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .row-name {
    display: flex;
    align-items: center;
    gap: 9px;
  }

  .badge {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    inline-size: 28px;
    block-size: 28px;
    box-sizing: border-box;
    border: var(--border-ink);
    border-radius: var(--radius-chip);
    background: var(--badge-fill);
    color: var(--paper-white);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    font-weight: var(--fw-strong);
  }

  /* White on yellow is illegible; the JPEG XL badge takes ink instead. */
  .badge-ink {
    color: var(--ink);
  }

  .codec {
    font-size: 16px;
    font-weight: var(--fw-strong);
    letter-spacing: var(--tracking-tight);
  }

  .note {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono-tight);
    color: var(--muted);
  }

  /* -- cells ------------------------------------------------------------ */

  .cell {
    padding: 0;
  }

  .cell.recommended {
    background: color-mix(in srgb, var(--accent-blue) 12%, var(--surface));
  }

  .cell-button {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    inline-size: 100%;
    padding: 14px 18px;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition: background var(--duration-fast) var(--ease-standard);
  }

  .cell-button:disabled {
    cursor: default;
  }

  .cell-button:not(:disabled):hover {
    background: color-mix(in srgb, var(--ink) 5%, transparent);
  }

  .figures {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    min-block-size: 24px;
  }

  .size {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-xl);
    font-weight: var(--fw-strong);
    letter-spacing: var(--tracking-tight);
  }

  .size.faded {
    color: var(--faint);
  }

  .pulsing {
    animation: pulse 1.1s var(--ease-standard) infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.35;
    }

    50% {
      opacity: 1;
    }
  }

  .saved {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    color: var(--muted);
  }

  .bar {
    position: relative;
    display: block;
    block-size: 3px;
    border-radius: var(--radius-pill);
    background: var(--hairline);
  }

  .bar-fill {
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;
    border-radius: var(--radius-pill);
    background: var(--ink);
    transition: inline-size var(--duration-normal) var(--ease-standard);
  }

  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    min-block-size: 20px;
  }

  .ssim {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono-tight);
    color: var(--muted);
  }

  /* -- footer ----------------------------------------------------------- */

  .foot-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .foot-left {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    flex-wrap: wrap;
  }

  .status {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono);
    text-transform: uppercase;
    color: var(--muted);
  }

  .sweep-error {
    margin: 0;
    font-size: var(--fs-mono-md);
    color: var(--accent-red);
  }

  .actions {
    display: flex;
    gap: var(--space-3);
  }

  /* -- mobile (no comp for 03; horizontal scroll + stacked chrome) ------- */

  @media (max-width: 720px) {
    .matrix {
      gap: var(--space-6);
      padding: var(--space-5);
    }

    .head {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-3);
    }

    .headline {
      font-size: var(--fs-h2);
      letter-spacing: var(--tracking-h2);
    }

    .explainer {
      font-size: var(--fs-sm);
      max-inline-size: none;
    }

    .foot-bar {
      flex-direction: column;
      align-items: stretch;
    }

    .foot-left {
      justify-content: space-between;
    }

    .actions {
      flex-direction: column;
    }

    .actions :global(.pill-button) {
      inline-size: 100%;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .pulsing {
      animation: none;
    }

    .bar-fill {
      transition: none;
    }
  }
</style>
