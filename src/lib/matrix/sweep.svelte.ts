/**
 * The codec matrix sweep: encode one image with every wasm encoder × four
 * steps, and tabulate weight, savings, SSIM and a verdict per cell.
 *
 * ## Shape
 * `createMatrixSweep()` returns a runes store. `rows` is `$state`, so a cell
 * landing repaints exactly that cell — the table fills in as the encodes come
 * back rather than appearing all at once at the end.
 *
 * ## What is swept
 * `MATRIX_ENCODERS` from the contracts: MozJPEG, WebP, AVIF, JPEG XL and
 * OxiPNG. The browser canvas encoders and QOI sit out — QOI and PNG have no
 * quality axis worth four columns, and `browser-*` are the same formats with
 * less control. OxiPNG *is* swept, but it is lossless: its columns are
 * {@link MATRIX_EFFORT_STEPS} (compression effort), not quality.
 *
 * ## Concurrency
 * One {@link WorkerBridgeApi} per lane, and **rows are dealt to lanes**
 * round-robin rather than cells: a lane then stays on one codec for four
 * consecutive encodes, so it loads one wasm module and keeps it warm instead
 * of thrashing five. Lane count is `AppSettings.workerThreads` (or
 * `hardwareConcurrency - 2`), clamped to `[1, MAX_MATRIX_CONCURRENCY]` and to
 * the number of rows.
 *
 * ## Metrics
 * SSIM is *injected* — this module never implements a perceptual metric. When
 * a `metrics` function is supplied, each encode is decoded back through the
 * same lane bridge and handed to it with the source pixels. With no metrics
 * function every `ssim` is `null`, every verdict reads "Unmeasured", and the
 * recommendation falls back to a documented, honest heuristic.
 *
 * ## Aborting
 * One `AbortController` per run. Cancelling aborts it *and* terminates every
 * lane worker, because wasm cannot be interrupted any other way. Cells that
 * never ran go back to `pending` and stay on screen; finished cells keep their
 * numbers. Starting a new run cancels the old one, and a late lane from the
 * cancelled run can never write into the new table (every write is guarded on
 * run identity).
 *
 * ## Reactive vs. bookkeeping state
 * Only display state lives in `$state`. The encode plan — including the
 * `SideSettings` handed to the worker — is kept in a private, unproxied array:
 * a Svelte proxy cannot be structured-cloned, so posting one to a worker
 * throws `DataCloneError`. The reactive cells carry their own plain copy for
 * the UI, and `settingsAt()` hands callers a fresh clone.
 */

import {
  ENCODER_IDS,
  MATRIX_ENCODERS,
  MATRIX_QUALITY_STEPS,
  THRESHOLDS,
  assertSignal,
  cloneSideSettings,
  createSideSettings,
  isAbortError,
  isWorkerDecodableMimeType,
  isWorkerEncoderId,
  savingsPct,
  verdictFor,
  type CreateWorkerBridge,
  type EncoderId,
  type EncoderOptionsMap,
  type EncoderRegistry,
  type MatrixCell,
  type MatrixRow,
  type MatrixSweepResult,
  type SideSettings,
  type Verdict,
  type WorkerBridgeApi,
  type WorkerEncoderId,
} from '../contracts';
import { toSrgb } from '../codecs';
import { ENCODER_ACCENT, accentFill } from '../ui/types';
import type { AccentName } from '../ui/types';

/* -------------------------------------------------------------------------- */
/* Steps & concurrency                                                         */
/* -------------------------------------------------------------------------- */

/**
 * OxiPNG's columns. `level` is compression effort, not quality: every level
 * produces the same pixels, only slower and smaller. 6 is oxipng's maximum.
 */
export const MATRIX_EFFORT_STEPS: readonly number[] = [0, 2, 4, 6];

/**
 * Upper bound on lanes. Each lane holds a full copy of the source pixels plus
 * a wasm heap, so past this "more cores" stops helping and starts swapping.
 */
export const MAX_MATRIX_CONCURRENCY = 8;

/** How often the elapsed clock repaints while a sweep runs, ms. */
export const ELAPSED_TICK_MS = 100;

/**
 * Quality floor for the fallback recommendation when SSIM is unavailable.
 * Below this, "smallest wins" would happily hand the user a q30 encode nobody
 * looked at. Lossless rows are exempt — they cannot degrade.
 */
export const UNMEASURED_QUALITY_FLOOR = 50;

/** `hardwareConcurrency - 2`, clamped. Falls back to 4 where it is unknown. */
export function recommendedMatrixConcurrency(): number {
  const cores =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 0;
  if (!cores) return 4;
  return Math.max(1, Math.min(MAX_MATRIX_CONCURRENCY, cores - 2));
}

function clampConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return recommendedMatrixConcurrency();
  return Math.max(1, Math.min(MAX_MATRIX_CONCURRENCY, Math.round(value)));
}

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type MatrixCellStatus = 'pending' | 'running' | 'done' | 'error';

/**
 * Compare an encode against the source. Returns SSIM in `[0, 1]`, or `null`
 * when the metric cannot be computed (dimensions differ, metric unavailable).
 * Injected so this module never pulls a metric implementation into its graph.
 */
export type MatrixMetricsFn = (
  original: ImageData,
  encoded: ImageData,
  signal?: AbortSignal,
) => Promise<number | null>;

/** A {@link MatrixCell} plus the live status the table renders. */
export interface MatrixSweepCell extends MatrixCell {
  /** Column index, matching {@link MatrixSweepStore.columns}. */
  readonly column: number;
  /** The value that varies across this row: quality, or OxiPNG effort. */
  readonly step: number;
  /** `Quality 50` / `Effort 4`, for tooltips and the apply button. */
  readonly stepLabel: string;
  status: MatrixCellStatus;
  /** Encode (plus metric) wall-clock in ms; `0` until the cell lands. */
  ms: number;
}

/** A {@link MatrixRow} with live cells and the bits the table needs to paint. */
export interface MatrixSweepRow extends Omit<MatrixRow, 'cells'> {
  /** The accent as a name, for `Chip`/`BrandDot` props. */
  readonly accentName: AccentName;
  /** True for encoders whose columns are effort levels. */
  readonly lossless: boolean;
  /** Ink rather than white text in the badge — yellow needs it. */
  readonly darkBadgeText: boolean;
  cells: MatrixSweepCell[];
}

export interface MatrixColumn {
  index: number;
  /** The quality this column means for lossy rows. */
  quality: number;
  /** The effort level the same column means for lossless rows. */
  effort: number;
  /** `Quality 50`. */
  label: string;
}

export interface MatrixSweepOptions {
  /**
   * One worker per lane. Required — the matrix never imports the codec worker
   * itself, so tests hand over a fake and the app hands over the real factory.
   */
  createBridge: CreateWorkerBridge;
  /** Real encoder metadata. Falls back to a local label/MIME table. */
  registry?: EncoderRegistry;
  /** Rows, in order. Defaults to `MATRIX_ENCODERS`. */
  encoders?: readonly EncoderId[];
  /** Columns, in order. Defaults to `MATRIX_QUALITY_STEPS`. */
  qualities?: readonly number[];
  /** Columns for lossless rows. Defaults to `MATRIX_EFFORT_STEPS`. */
  efforts?: readonly number[];
  /** Lane count. Defaults to {@link recommendedMatrixConcurrency}. */
  concurrency?: number;
  /** Perceptual metric. Absent ⇒ every cell's `ssim` is `null`. */
  metrics?: MatrixMetricsFn;
  /** Force measuring on/off. Defaults to "on when `metrics` is supplied". */
  measure?: boolean;
  /** Cancels every run this store starts (view teardown, tab close). */
  signal?: AbortSignal;
  /** Elapsed-clock interval. `0` disables the clock (tests). */
  tickMs?: number;
}

/** Per-run overrides — the view passes the live `AppSettings.workerThreads`. */
export interface MatrixRunOptions {
  concurrency?: number;
  measure?: boolean;
}

export interface MatrixSweepStore {
  readonly rows: readonly MatrixSweepRow[];
  readonly columns: readonly MatrixColumn[];
  /** True between `run()` and completion/cancellation. */
  readonly running: boolean;
  /** True once a run finished without being cancelled. */
  readonly done: boolean;
  /** Wall-clock of the current or last run, ms. Ticks while running. */
  readonly elapsedMs: number;
  /** Cells in the whole table. */
  readonly totalEncodes: number;
  /** Cells that landed successfully. */
  readonly completedEncodes: number;
  /** Cells that failed. */
  readonly failedEncodes: number;
  /** Lanes the current or last run used. */
  readonly threads: number;
  /** True when the last run actually measured SSIM. */
  readonly measured: boolean;
  /** Size of the source file the savings are computed against. */
  readonly originalBytes: number;
  /** Whole-sweep failure (could not spawn a worker…), not a per-cell error. */
  readonly error: string | undefined;
  /** The recommended cell, or `null` while nothing qualifies yet. */
  readonly recommended: MatrixSweepCell | null;
  /** The row the recommendation sits in. */
  readonly recommendedRow: MatrixSweepRow | null;
  /** A fresh, unproxied copy of the recommended cell's settings. */
  readonly recommendedSettings: SideSettings | null;
  /** Encoders the editor offers but the sweep skips, as labels. */
  readonly excludedLabels: readonly string[];

  /** A fresh, unproxied copy of one cell's settings — safe to hand to a worker. */
  settingsAt(row: number, cell: number): SideSettings | null;
  /** Plain snapshot matching the `MatrixSweepResult` contract. */
  toResult(): MatrixSweepResult;

  /** Cancel anything running, clear the table, and sweep `source`. */
  run(source: ImageData, originalBytes: number, options?: MatrixRunOptions): Promise<void>;
  /** Abort the run and terminate its workers. Finished cells stay on screen. */
  cancel(): void;
  /** Cancel and put every cell back to `pending`. */
  reset(): void;
  /** Cancel, terminate, and stop the clock. The store is unusable afterwards. */
  dispose(): void;
}

/* -------------------------------------------------------------------------- */
/* Fallback metadata (used only when no registry is injected)                  */
/* -------------------------------------------------------------------------- */

const FALLBACK_LABELS: Readonly<Record<EncoderId, string>> = {
  identity: 'Original',
  mozjpeg: 'MozJPEG',
  oxipng: 'OxiPNG',
  webp: 'WebP',
  avif: 'AVIF',
  jxl: 'JPEG XL',
  qoi: 'QOI',
  'browser-jpeg': 'Browser JPEG',
  'browser-png': 'Browser PNG',
  'browser-webp': 'Browser WebP',
};

const FALLBACK_MIME: Readonly<Record<EncoderId, string>> = {
  identity: '',
  mozjpeg: 'image/jpeg',
  oxipng: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  jxl: 'image/jxl',
  qoi: 'image/qoi',
  'browser-jpeg': 'image/jpeg',
  'browser-png': 'image/png',
  'browser-webp': 'image/webp',
};

/** Sub-labels under the codec name. Deliberately factual, not promotional. */
const ROW_NOTES: Readonly<Partial<Record<EncoderId, string>>> = {
  mozjpeg: 'Opens anywhere · no alpha',
  webp: 'Smaller than JPEG · wide support',
  avif: 'Best ratio · slowest to encode',
  jxl: 'Strong ratio · limited support',
  oxipng: 'Lossless · columns are effort',
  qoi: 'Lossless · fast, niche',
};

/** Which encoders have no quality axis and are therefore swept by effort. */
const LOSSLESS_ROWS: ReadonlySet<EncoderId> = new Set<EncoderId>(['oxipng', 'qoi']);

const FAILED_VERDICT: Verdict = { label: 'Failed', tone: 'warn' };

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

export function isLosslessSweepRow(encoderId: EncoderId): boolean {
  return LOSSLESS_ROWS.has(encoderId);
}

/** Column values for one row: qualities, or effort levels for lossless rows. */
export function stepsFor(
  encoderId: EncoderId,
  qualities: readonly number[],
  efforts: readonly number[] = MATRIX_EFFORT_STEPS,
): number[] {
  if (!isLosslessSweepRow(encoderId)) return [...qualities];
  const last = efforts[efforts.length - 1] ?? 2;
  return qualities.map((_unused, index) => efforts[index] ?? last);
}

/** `Quality 50` / `Effort 4`. */
export function stepLabelFor(encoderId: EncoderId, step: number): string {
  return `${isLosslessSweepRow(encoderId) ? 'Effort' : 'Quality'} ${step}`;
}

/** The `SideSettings` one cell encodes with. Always a fresh plain object. */
export function settingsForStep(encoderId: EncoderId, step: number): SideSettings {
  switch (encoderId) {
    case 'oxipng':
      return createSideSettings('oxipng', { level: Math.max(0, Math.min(6, step)) });
    case 'mozjpeg':
      return createSideSettings('mozjpeg', { quality: step });
    case 'webp':
      return createSideSettings('webp', { quality: step });
    case 'avif':
      return createSideSettings('avif', { quality: step });
    case 'jxl':
      return createSideSettings('jxl', { quality: step });
    default:
      // Anything else has no quality axis here; take its defaults verbatim.
      return createSideSettings(encoderId) as SideSettings;
  }
}

/** Largest landed encode in a row — the 100% mark of the cell progress bars. */
export function rowMaxSize(row: MatrixSweepRow): number {
  let max = 0;
  for (const cell of row.cells) if (cell.size !== null && cell.size > max) max = cell.size;
  return max;
}

/** Bar width as a 0–100 percentage of the row's largest encode. */
export function barPercent(row: MatrixSweepRow, cell: MatrixSweepCell): number {
  const max = rowMaxSize(row);
  if (max <= 0 || cell.size === null) return 0;
  return Math.max(2, Math.min(100, Math.round((cell.size / max) * 100)));
}

interface Candidate {
  row: number;
  cell: number;
  size: number;
  ssim: number | null;
  savedPct: number;
  step: number;
  lossless: boolean;
}

/**
 * "The smallest encode still above the perceptual threshold."
 *
 * 1. Only landed cells are eligible.
 * 2. With SSIM: keep the cells at or above {@link THRESHOLDS.good}. If none
 *    clear it, keep the single best-scoring cell rather than pretending.
 * 3. Without SSIM: keep the cells at or above
 *    {@link UNMEASURED_QUALITY_FLOOR} — plus every lossless cell, which cannot
 *    degrade at any effort.
 * 4. Prefer cells that actually save something ({@link THRESHOLDS.savingsFloor}).
 * 5. Smallest wins; ties go to the higher SSIM, then to row/column order.
 */
export function pickRecommended(
  rows: readonly MatrixSweepRow[],
  qualityFloor: number = UNMEASURED_QUALITY_FLOOR,
): { row: number; cell: number } | null {
  const candidates: Candidate[] = [];

  rows.forEach((row, rowIndex) => {
    row.cells.forEach((cell, cellIndex) => {
      if (cell.status !== 'done' || cell.size === null) return;
      candidates.push({
        row: rowIndex,
        cell: cellIndex,
        size: cell.size,
        ssim: cell.ssim,
        savedPct: cell.savedPct,
        step: cell.step,
        lossless: row.lossless,
      });
    });
  });

  if (candidates.length === 0) return null;

  const measured = candidates.filter((candidate) => candidate.ssim !== null);
  let pool: Candidate[];

  if (measured.length > 0) {
    pool = measured.filter((candidate) => (candidate.ssim ?? 0) >= THRESHOLDS.good);
    if (pool.length === 0) {
      const best = measured.reduce((a, b) => ((b.ssim ?? 0) > (a.ssim ?? 0) ? b : a));
      pool = [best];
    }
  } else {
    pool = candidates.filter(
      (candidate) => candidate.lossless || candidate.step >= qualityFloor,
    );
    if (pool.length === 0) pool = candidates;
  }

  const worthwhile = pool.filter(
    (candidate) => candidate.savedPct >= THRESHOLDS.savingsFloor,
  );
  if (worthwhile.length > 0) pool = worthwhile;

  const winner = pool.reduce((best, candidate) => {
    if (candidate.size !== best.size) return candidate.size < best.size ? candidate : best;
    const bestSsim = best.ssim ?? 0;
    const candidateSsim = candidate.ssim ?? 0;
    if (candidateSsim !== bestSsim) return candidateSsim > bestSsim ? candidate : best;
    return best;
  });

  return { row: winner.row, cell: winner.cell };
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

/** One cell's encode plan. Never proxied — it is posted to a worker. */
interface MatrixJob {
  readonly encoderId: EncoderId;
  readonly step: number;
  readonly settings: SideSettings;
}

interface ActiveRun {
  controller: AbortController;
  bridges: Map<number, WorkerBridgeApi>;
}

export function createMatrixSweep(options: MatrixSweepOptions): MatrixSweepStore {
  const encoders = options.encoders ?? MATRIX_ENCODERS;
  const qualities = options.qualities ?? MATRIX_QUALITY_STEPS;
  const efforts = options.efforts ?? MATRIX_EFFORT_STEPS;
  const registry = options.registry;
  const metrics = options.metrics;
  const tickMs = options.tickMs ?? ELAPSED_TICK_MS;

  const label = (id: EncoderId): string => registry?.[id]?.label ?? FALLBACK_LABELS[id];
  const mimeOf = (id: EncoderId): string => registry?.[id]?.mimeType ?? FALLBACK_MIME[id];

  /* -- plan (private, unproxied) ----------------------------------------- */

  const plan: MatrixJob[][] = encoders.map((encoderId) =>
    stepsFor(encoderId, qualities, efforts).map((step) => ({
      encoderId,
      step,
      settings: settingsForStep(encoderId, step),
    })),
  );

  function buildRows(): MatrixSweepRow[] {
    return encoders.map((encoderId, rowIndex) => {
      const accentName = ENCODER_ACCENT[encoderId];
      const name = label(encoderId);
      const jobs = plan[rowIndex] ?? [];

      return {
        encoderId,
        label: name,
        initial: (name.trim()[0] ?? '?').toUpperCase(),
        note: ROW_NOTES[encoderId] ?? '',
        accent: accentFill(accentName),
        accentName,
        lossless: isLosslessSweepRow(encoderId),
        // White on yellow is unreadable; the JPEG XL badge takes ink instead.
        darkBadgeText: accentName === 'yellow',
        cells: jobs.map((job, column) => emptyCell(job, column)),
      };
    });
  }

  function emptyCell(job: MatrixJob, column: number): MatrixSweepCell {
    return {
      column,
      step: job.step,
      stepLabel: stepLabelFor(job.encoderId, job.step),
      status: 'pending',
      size: null,
      savedPct: 0,
      ssim: null,
      verdict: verdictFor(null),
      recommended: false,
      settings: cloneSideSettings(job.settings),
      ms: 0,
    };
  }

  /* -- reactive state ----------------------------------------------------- */

  const rows = $state<MatrixSweepRow[]>(buildRows());
  const lastEffort = efforts[efforts.length - 1] ?? 2;
  const columns: MatrixColumn[] = qualities.map((quality, index) => ({
    index,
    quality,
    effort: efforts[index] ?? lastEffort,
    label: `Quality ${quality}`,
  }));

  let running = $state(false);
  let finished = $state(false);
  let elapsedMs = $state(0);
  let completed = $state(0);
  let failed = $state(0);
  let threads = $state(clampConcurrency(options.concurrency));
  let measuring = $state(options.measure ?? metrics !== undefined);
  let originalBytes = $state(0);
  let sweepError = $state<string | undefined>(undefined);
  let pickRow = $state(-1);
  let pickCell = $state(-1);

  /* -- bookkeeping (outside the proxy) ------------------------------------ */

  let current: ActiveRun | undefined;
  let startedAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  /** Encoders the editor offers that this sweep does not cover, in list order. */
  const excludedLabels: string[] = ENCODER_IDS.filter(
    (id) => id !== 'identity' && !encoders.includes(id),
  ).map(label);

  /* -- clock -------------------------------------------------------------- */

  function stopClock(): void {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  }

  function startClock(): void {
    stopClock();
    if (!Number.isFinite(tickMs) || tickMs <= 0) return;
    timer = setInterval(() => {
      elapsedMs = now() - startedAt;
    }, tickMs);
  }

  /* -- table mutation ----------------------------------------------------- */

  function resetCells(): void {
    rows.forEach((row, rowIndex) => {
      const jobs = plan[rowIndex] ?? [];
      row.cells.forEach((cell, cellIndex) => {
        const job = jobs[cellIndex];
        cell.status = 'pending';
        cell.size = null;
        cell.savedPct = 0;
        cell.ssim = null;
        cell.verdict = verdictFor(null);
        cell.recommended = false;
        cell.ms = 0;
        cell.error = undefined;
        if (job) cell.settings = cloneSideSettings(job.settings);
      });
    });
    pickRow = -1;
    pickCell = -1;
    completed = 0;
    failed = 0;
  }

  function refreshRecommendation(): void {
    const pick = pickRecommended(rows);
    pickRow = pick?.row ?? -1;
    pickCell = pick?.cell ?? -1;

    rows.forEach((row, rowIndex) => {
      row.cells.forEach((cell, cellIndex) => {
        const next = rowIndex === pickRow && cellIndex === pickCell;
        if (cell.recommended !== next) cell.recommended = next;
      });
    });
  }

  /* -- running ------------------------------------------------------------ */

  function bridgeFor(run: ActiveRun, lane: number): WorkerBridgeApi {
    let bridge = run.bridges.get(lane);
    if (!bridge) {
      bridge = options.createBridge();
      run.bridges.set(lane, bridge);
    }
    return bridge;
  }

  async function measureCell(
    bridge: WorkerBridgeApi,
    encoderId: EncoderId,
    buffer: ArrayBuffer,
    source: ImageData,
    signal: AbortSignal,
  ): Promise<number | null> {
    if (!metrics) return null;
    const mimeType = mimeOf(encoderId);
    if (!isWorkerDecodableMimeType(mimeType)) return null;

    try {
      // `decode` transfers the buffer — its size was read before this call.
      const decoded = await bridge.decode(signal, mimeType, buffer);
      assertSignal(signal);
      return await metrics(source, decoded, signal);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;
      // A metric that cannot run is reported as "unmeasured", not as a failed
      // encode — the size figure is still perfectly good.
      return null;
    }
  }

  async function encodeCell(
    run: ActiveRun,
    lane: number,
    job: MatrixJob,
    cell: MatrixSweepCell,
    source: ImageData,
  ): Promise<void> {
    const signal = run.controller.signal;
    const started = now();
    cell.status = 'running';

    try {
      const encoderId = job.encoderId;
      if (!isWorkerEncoderId(encoderId)) {
        throw new Error(`${label(encoderId)} has no wasm encoder to sweep.`);
      }

      const bridge = bridgeFor(run, lane);
      const encoderOptions = job.settings.encoderOptions as EncoderOptionsMap[WorkerEncoderId];
      const buffer = await bridge.encode(signal, encoderId, source, encoderOptions);
      assertSignal(signal);

      const size = buffer.byteLength;
      const ssim = measuring
        ? await measureCell(bridge, encoderId, buffer, source, signal)
        : null;
      assertSignal(signal);
      if (current !== run) return;

      cell.size = size;
      cell.savedPct = savingsPct(originalBytes, size);
      cell.ssim = ssim;
      cell.verdict = verdictFor(ssim);
      cell.error = undefined;
      cell.ms = now() - started;
      cell.status = 'done';
      completed += 1;
      refreshRecommendation();
    } catch (error) {
      if (current !== run) return;
      if (isAbortError(error) || signal.aborted) {
        cell.status = 'pending';
        return;
      }
      cell.size = null;
      cell.savedPct = 0;
      cell.ssim = null;
      cell.verdict = FAILED_VERDICT;
      cell.error = messageOf(error);
      cell.ms = now() - started;
      cell.status = 'error';
      failed += 1;
    }
  }

  /**
   * Lanes take whole rows, `lane`, `lane + lanes`, … so a lane stays on one
   * codec and reuses its warm wasm instead of loading all five.
   */
  async function runLane(
    run: ActiveRun,
    lane: number,
    lanes: number,
    source: ImageData,
  ): Promise<void> {
    for (let rowIndex = lane; rowIndex < plan.length; rowIndex += lanes) {
      const jobs = plan[rowIndex];
      const row = rows[rowIndex];
      if (!jobs || !row) continue;

      for (let cellIndex = 0; cellIndex < jobs.length; cellIndex += 1) {
        if (run.controller.signal.aborted || current !== run) return;
        const job = jobs[cellIndex];
        const cell = row.cells[cellIndex];
        if (!job || !cell) continue;
        await encodeCell(run, lane, job, cell, source);
      }
    }
  }

  async function run(
    rawSource: ImageData,
    bytes: number,
    runOptions: MatrixRunOptions = {},
  ): Promise<void> {
    if (disposed) return;
    cancel();

    // The wasm codecs assume unprofiled sRGB. Gamut-map a wide-gamut source down
    // once, up front, so every cell encodes and is measured in the same space
    // the editor's recommendation will actually produce. No-op for sRGB.
    const source = toSrgb(rawSource);

    originalBytes = Math.max(0, Math.round(bytes));
    measuring = runOptions.measure ?? options.measure ?? metrics !== undefined;
    sweepError = undefined;
    finished = false;
    resetCells();

    const laneCount = Math.max(
      1,
      Math.min(clampConcurrency(runOptions.concurrency ?? options.concurrency), rows.length),
    );
    threads = laneCount;

    const active: ActiveRun = { controller: new AbortController(), bridges: new Map() };
    current = active;

    const external = options.signal;
    const onExternalAbort = () => active.controller.abort();
    if (external) {
      if (external.aborted) active.controller.abort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }

    running = true;
    startedAt = now();
    elapsedMs = 0;
    startClock();

    try {
      await Promise.all(
        Array.from({ length: laneCount }, (_unused, lane) =>
          runLane(active, lane, laneCount, source),
        ),
      );
      if (current === active && !active.controller.signal.aborted) finished = true;
    } catch (error) {
      if (current === active && !isAbortError(error)) sweepError = messageOf(error);
    } finally {
      external?.removeEventListener('abort', onExternalAbort);
      for (const bridge of active.bridges.values()) bridge.terminate();
      active.bridges.clear();

      if (current === active) {
        current = undefined;
        stopClock();
        elapsedMs = now() - startedAt;
        running = false;
        // A lane that ignored the signal can strand a cell mid-flight.
        for (const row of rows) {
          for (const cell of row.cells) if (cell.status === 'running') cell.status = 'pending';
        }
        refreshRecommendation();
      }
    }
  }

  function cancel(): void {
    const active = current;
    if (!active) return;
    active.controller.abort();
    // wasm cannot be interrupted from the outside: terminate is the only cancel.
    for (const bridge of active.bridges.values()) bridge.terminate();
  }

  function reset(): void {
    cancel();
    resetCells();
    finished = false;
    elapsedMs = 0;
    sweepError = undefined;
  }

  function dispose(): void {
    disposed = true;
    cancel();
    stopClock();
    current = undefined;
    running = false;
  }

  /* -- reads -------------------------------------------------------------- */

  function settingsAt(rowIndex: number, cellIndex: number): SideSettings | null {
    const job = plan[rowIndex]?.[cellIndex];
    return job ? cloneSideSettings(job.settings) : null;
  }

  function recommendedCell(): MatrixSweepCell | null {
    return rows[pickRow]?.cells[pickCell] ?? null;
  }

  function toResult(): MatrixSweepResult {
    const pick = recommendedCell();
    const pickedRow = rows[pickRow];

    return {
      rows: rows.map((row, rowIndex) => ({
        encoderId: row.encoderId,
        label: row.label,
        initial: row.initial,
        note: row.note,
        accent: row.accent,
        cells: row.cells.map((cell, cellIndex) => ({
          size: cell.size,
          savedPct: cell.savedPct,
          ssim: cell.ssim,
          verdict: { label: cell.verdict.label, tone: cell.verdict.tone },
          recommended: cell.recommended,
          settings: settingsAt(rowIndex, cellIndex) ?? cloneSideSettings(cell.settings),
          error: cell.error,
        })),
      })),
      encodes: completed,
      ms: elapsedMs,
      recommended:
        pick && pickedRow ? { encoderId: pickedRow.encoderId, quality: pick.step } : null,
    };
  }

  return {
    get rows() {
      return rows;
    },
    get columns() {
      return columns;
    },
    get running() {
      return running;
    },
    get done() {
      return finished;
    },
    get elapsedMs() {
      return elapsedMs;
    },
    // Recomputed per read rather than `$derived`, so the store behaves
    // identically under the SSR/node compilation used by vitest.
    get totalEncodes() {
      let total = 0;
      for (const row of rows) total += row.cells.length;
      return total;
    },
    get completedEncodes() {
      return completed;
    },
    get failedEncodes() {
      return failed;
    },
    get threads() {
      return threads;
    },
    get measured() {
      return measuring;
    },
    get originalBytes() {
      return originalBytes;
    },
    get error() {
      return sweepError;
    },
    get recommended() {
      return recommendedCell();
    },
    get recommendedRow() {
      return rows[pickRow] ?? null;
    },
    get recommendedSettings() {
      return settingsAt(pickRow, pickCell);
    },
    get excludedLabels() {
      return excludedLabels;
    },

    settingsAt,
    toResult,
    run,
    cancel,
    reset,
    dispose,
  };
}

/**
 * Create a store and start sweeping immediately — the one-liner form.
 * The returned store is live: read `rows`/`running` from a component.
 */
export function runMatrixSweep(
  source: ImageData,
  originalBytes: number,
  options: MatrixSweepOptions,
): MatrixSweepStore {
  const store = createMatrixSweep(options);
  void store.run(source, originalBytes);
  return store;
}
