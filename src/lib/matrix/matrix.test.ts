/**
 * Codec-matrix tests. No DOM and no wasm: a fake worker bridge stands in for
 * the codec layer, which is exactly why `createMatrixSweep` takes the bridge
 * factory as an argument.
 *
 * The fake sizes are chosen so the sweep's answer is the comp's answer —
 * "Use AVIF q50" — which makes the recommendation rule readable as a test.
 */

import { describe, expect, it } from 'vitest';
import type {
  RotateAngle,
  WorkerBridgeApi,
  WorkerDecodableMimeType,
  WorkerEncoderId,
  WorkerResizeOptions,
} from '../contracts';
import {
  MATRIX_EFFORT_STEPS,
  barPercent,
  createMatrixSweep,
  isLosslessSweepRow,
  pickRecommended,
  settingsForStep,
  stepLabelFor,
  stepsFor,
  type MatrixSweepRow,
} from './sweep.svelte';
import {
  describeSweep,
  formatBytes,
  formatSavedPct,
  formatSsim,
  joinList,
  numberWord,
  stepShortLabel,
} from './format';

/* -------------------------------------------------------------------------- */
/* Fakes                                                                       */
/* -------------------------------------------------------------------------- */

const ORIGINAL_BYTES = 1000;

/** Encoded size per encoder × step. Every value is unique on purpose. */
const SIZES: Record<string, number> = {
  'mozjpeg:30': 300,
  'mozjpeg:50': 500,
  'mozjpeg:70': 700,
  'mozjpeg:90': 900,
  'webp:30': 250,
  'webp:50': 420,
  'webp:70': 600,
  'webp:90': 800,
  'avif:30': 200,
  'avif:50': 350,
  'avif:70': 520,
  'avif:90': 690,
  'jxl:30': 220,
  'jxl:50': 380,
  'jxl:70': 560,
  'jxl:90': 740,
  'oxipng:0': 951,
  'oxipng:2': 931,
  'oxipng:4': 911,
  'oxipng:6': 901,
};

/** SSIM per step. q30 sits below `THRESHOLDS.good`; OxiPNG is lossless. */
const SSIM_BY_SIZE = new Map<number, number>();
for (const [key, size] of Object.entries(SIZES)) {
  const step = Number(key.split(':')[1] ?? 0);
  const lossless = key.startsWith('oxipng');
  SSIM_BY_SIZE.set(
    size,
    lossless ? 1 : step >= 90 ? 0.998 : step >= 70 ? 0.994 : step >= 50 ? 0.988 : 0.95,
  );
}

function stepOf(id: string, options: unknown): number {
  const bag = (options ?? {}) as Record<string, unknown>;
  const value = id === 'oxipng' ? bag['level'] : bag['quality'];
  return typeof value === 'number' ? value : 0;
}

const fakeImage = (width = 8, height = 8): ImageData =>
  ({ data: new Uint8ClampedArray(width * height * 4), width, height }) as unknown as ImageData;

interface FakeBridgeOptions {
  /** Encoders that should reject instead of encoding. */
  failing?: readonly WorkerEncoderId[];
  /** Delay before an encode settles, ms. `0` resolves on the microtask queue. */
  delayMs?: number;
}

interface FakeBridge extends WorkerBridgeApi {
  terminated: number;
}

function createFakeBridgeFactory(options: FakeBridgeOptions = {}): {
  create: () => WorkerBridgeApi;
  bridges: FakeBridge[];
} {
  const bridges: FakeBridge[] = [];
  const failing = new Set(options.failing ?? []);
  const delayMs = options.delayMs ?? 0;

  const create = (): WorkerBridgeApi => {
    const bridge: FakeBridge = {
      terminated: 0,
      encode(signal, id, _data, encoderOptions) {
        return new Promise<ArrayBuffer>((resolve, reject) => {
          const fail = () => reject(new DOMException('aborted', 'AbortError'));
          if (signal.aborted) return fail();

          const timer = setTimeout(() => {
            signal.removeEventListener('abort', fail);
            if (failing.has(id)) {
              reject(new Error(`${id} exploded`));
              return;
            }
            const size = SIZES[`${id}:${stepOf(id, encoderOptions)}`] ?? 1;
            resolve(new ArrayBuffer(size));
          }, delayMs);

          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              fail();
            },
            { once: true },
          );
        });
      },
      decode(_signal: AbortSignal, _mime: WorkerDecodableMimeType, buffer: ArrayBuffer) {
        // The decoded width carries the encoded size, so the metric below can
        // map a cell back to a deterministic SSIM without any pixel maths.
        return Promise.resolve(fakeImage(buffer.byteLength, 1));
      },
      resize(_signal: AbortSignal, data: ImageData, _options: WorkerResizeOptions) {
        return Promise.resolve(data);
      },
      rotate(_signal: AbortSignal, data: ImageData, _angle: RotateAngle) {
        return Promise.resolve(data);
      },
      preload() {
        /* no-op */
      },
      terminate() {
        bridge.terminated += 1;
      },
    };
    bridges.push(bridge);
    return bridge;
  };

  return { create, bridges };
}

const fakeMetrics = async (_original: ImageData, encoded: ImageData): Promise<number | null> =>
  SSIM_BY_SIZE.get(encoded.width) ?? null;

/* -------------------------------------------------------------------------- */
/* Plan helpers                                                                */
/* -------------------------------------------------------------------------- */

describe('sweep plan', () => {
  it('sweeps lossless encoders by effort and everything else by quality', () => {
    expect(isLosslessSweepRow('oxipng')).toBe(true);
    expect(isLosslessSweepRow('avif')).toBe(false);

    expect(stepsFor('avif', [30, 50, 70, 90])).toEqual([30, 50, 70, 90]);
    expect(stepsFor('oxipng', [30, 50, 70, 90])).toEqual([...MATRIX_EFFORT_STEPS]);
    expect(stepLabelFor('oxipng', 4)).toBe('Effort 4');
    expect(stepLabelFor('avif', 50)).toBe('Quality 50');
  });

  it('builds settings the engine can consume directly', () => {
    const avif = settingsForStep('avif', 50);
    expect(avif.encoderId).toBe('avif');
    expect(avif.encoderOptions).toMatchObject({ quality: 50 });

    const oxipng = settingsForStep('oxipng', 6);
    expect(oxipng.encoderId).toBe('oxipng');
    expect(oxipng.encoderOptions).toMatchObject({ level: 6 });

    // Effort is clamped to oxipng's 0–6 range rather than passed through.
    expect(settingsForStep('oxipng', 42).encoderOptions).toMatchObject({ level: 6 });
  });

  it('seeds a pending table before anything runs', () => {
    const { create } = createFakeBridgeFactory();
    const sweep = createMatrixSweep({ createBridge: create, tickMs: 0 });

    expect(sweep.rows).toHaveLength(5);
    expect(sweep.columns.map((column) => column.label)).toEqual([
      'Quality 30',
      'Quality 50',
      'Quality 70',
      'Quality 90',
    ]);
    expect(sweep.totalEncodes).toBe(20);
    expect(sweep.running).toBe(false);
    expect(sweep.done).toBe(false);
    expect(sweep.rows.every((row) => row.cells.every((cell) => cell.status === 'pending'))).toBe(
      true,
    );
    expect(sweep.excludedLabels).toEqual([
      'QOI',
      'Browser JPEG',
      'Browser PNG',
      'Browser WebP',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Running                                                                     */
/* -------------------------------------------------------------------------- */

describe('runMatrixSweep', () => {
  it('fills every cell with size, savings, SSIM and a verdict', async () => {
    const { create, bridges } = createFakeBridgeFactory();
    const sweep = createMatrixSweep({
      createBridge: create,
      metrics: fakeMetrics,
      concurrency: 3,
      tickMs: 0,
    });

    await sweep.run(fakeImage(), ORIGINAL_BYTES);

    expect(sweep.running).toBe(false);
    expect(sweep.done).toBe(true);
    expect(sweep.completedEncodes).toBe(20);
    expect(sweep.failedEncodes).toBe(0);
    expect(sweep.threads).toBe(3);
    expect(sweep.measured).toBe(true);

    const avif = sweep.rows.find((row) => row.encoderId === 'avif');
    const cell = avif?.cells[1];
    expect(cell?.size).toBe(350);
    expect(cell?.savedPct).toBe(65);
    expect(cell?.ssim).toBe(0.988);
    expect(cell?.verdict.label).toBe('Good');
    expect(cell?.status).toBe('done');

    // Lossless rows report SSIM 1 and the matching verdict.
    const oxipng = sweep.rows.find((row) => row.encoderId === 'oxipng');
    expect(oxipng?.cells[3]?.verdict.label).toBe('Lossless');
    expect(oxipng?.cells[3]?.step).toBe(6);

    // Every lane's worker is terminated once the sweep is over.
    expect(bridges.length).toBe(3);
    expect(bridges.every((bridge) => bridge.terminated > 0)).toBe(true);
  });

  it('recommends the smallest encode still above the perceptual threshold', async () => {
    const { create } = createFakeBridgeFactory();
    const sweep = createMatrixSweep({
      createBridge: create,
      metrics: fakeMetrics,
      concurrency: 5,
      tickMs: 0,
    });

    await sweep.run(fakeImage(), ORIGINAL_BYTES);

    // AVIF q30 (200 B) and WebP q30 (250 B) are smaller but score 0.95.
    expect(sweep.recommendedRow?.encoderId).toBe('avif');
    expect(sweep.recommended?.step).toBe(50);

    const flagged = sweep.rows.flatMap((row) => row.cells).filter((cell) => cell.recommended);
    expect(flagged).toHaveLength(1);

    const settings = sweep.recommendedSettings;
    expect(settings?.encoderId).toBe('avif');
    expect(settings?.encoderOptions).toMatchObject({ quality: 50 });

    const result = sweep.toResult();
    expect(result.recommended).toEqual({ encoderId: 'avif', quality: 50 });
    expect(result.encodes).toBe(20);
    expect(result.rows).toHaveLength(5);
  });

  it('keeps a failing encoder from taking the rest of the table with it', async () => {
    const { create } = createFakeBridgeFactory({ failing: ['jxl'] });
    const sweep = createMatrixSweep({
      createBridge: create,
      metrics: fakeMetrics,
      concurrency: 5,
      tickMs: 0,
    });

    await sweep.run(fakeImage(), ORIGINAL_BYTES);

    const jxl = sweep.rows.find((row) => row.encoderId === 'jxl');
    expect(jxl?.cells.every((cell) => cell.status === 'error')).toBe(true);
    expect(jxl?.cells[0]?.verdict.label).toBe('Failed');
    expect(jxl?.cells[0]?.error).toContain('jxl exploded');
    expect(jxl?.cells[0]?.size).toBeNull();

    expect(sweep.failedEncodes).toBe(4);
    expect(sweep.completedEncodes).toBe(16);
    expect(sweep.done).toBe(true);
    expect(sweep.recommendedRow?.encoderId).toBe('avif');
  });

  it('cancels: workers are terminated and unstarted cells stay pending', async () => {
    const { create, bridges } = createFakeBridgeFactory({ delayMs: 20 });
    const sweep = createMatrixSweep({ createBridge: create, concurrency: 2, tickMs: 0 });

    const running = sweep.run(fakeImage(), ORIGINAL_BYTES);
    expect(sweep.running).toBe(true);
    sweep.cancel();
    await running;

    expect(sweep.running).toBe(false);
    expect(sweep.done).toBe(false);
    expect(sweep.completedEncodes).toBe(0);
    expect(sweep.rows.every((row) => row.cells.every((cell) => cell.status === 'pending'))).toBe(
      true,
    );
    expect(bridges.every((bridge) => bridge.terminated > 0)).toBe(true);
  });

  it('reports every SSIM as null when no metric is injected', async () => {
    const { create } = createFakeBridgeFactory();
    const sweep = createMatrixSweep({ createBridge: create, concurrency: 4, tickMs: 0 });

    await sweep.run(fakeImage(), ORIGINAL_BYTES);

    expect(sweep.measured).toBe(false);
    const cells = sweep.rows.flatMap((row) => row.cells);
    expect(cells.every((cell) => cell.ssim === null)).toBe(true);
    expect(cells.every((cell) => cell.verdict.label === 'Unmeasured')).toBe(true);

    // Fallback rule: never a q30 encode, and lossless rows stay eligible.
    expect(sweep.recommended?.step).not.toBe(30);
    expect(sweep.recommended?.size).toBe(350);
  });

  it('re-runs on a new source without leaking the previous table', async () => {
    const { create } = createFakeBridgeFactory();
    const sweep = createMatrixSweep({ createBridge: create, concurrency: 2, tickMs: 0 });

    await sweep.run(fakeImage(), ORIGINAL_BYTES);
    expect(sweep.completedEncodes).toBe(20);

    const second = sweep.run(fakeImage(16, 16), 2000);
    expect(sweep.completedEncodes).toBe(0);
    await second;

    expect(sweep.completedEncodes).toBe(20);
    expect(sweep.originalBytes).toBe(2000);
    // Savings are recomputed against the new original.
    const avif = sweep.rows.find((row) => row.encoderId === 'avif');
    expect(avif?.cells[1]?.savedPct).toBe(83);
  });
});

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

function rowOf(sizes: readonly (number | null)[], ssims: readonly (number | null)[]): MatrixSweepRow {
  return {
    encoderId: 'avif',
    label: 'AVIF',
    initial: 'A',
    note: '',
    accent: 'var(--accent-purple)',
    accentName: 'purple',
    lossless: false,
    darkBadgeText: false,
    cells: sizes.map((size, index) => ({
      column: index,
      step: [30, 50, 70, 90][index] ?? 30,
      stepLabel: `Quality ${[30, 50, 70, 90][index] ?? 30}`,
      status: size === null ? 'pending' : 'done',
      size,
      savedPct: size === null ? 0 : Math.round(((1000 - size) / 1000) * 100),
      ssim: ssims[index] ?? null,
      verdict: { label: 'Good', tone: 'good' },
      recommended: false,
      settings: settingsForStep('avif', [30, 50, 70, 90][index] ?? 30),
      ms: 0,
    })),
  };
}

describe('pickRecommended', () => {
  it('ignores cells that have not landed', () => {
    const row = rowOf([null, null, null, null], [null, null, null, null]);
    expect(pickRecommended([row])).toBeNull();
  });

  it('falls back to the best-scoring cell when nothing clears the threshold', () => {
    const row = rowOf([200, 300, 400, 500], [0.9, 0.93, 0.95, 0.96]);
    expect(pickRecommended([row])).toEqual({ row: 0, cell: 3 });
  });

  it('skips encodes that barely save anything', () => {
    // 980 B off a 1000 B original is a 2% saving — below the savings floor.
    const row = rowOf([980, 400, 500, 600], [0.999, 0.99, 0.995, 0.997]);
    expect(pickRecommended([row])).toEqual({ row: 0, cell: 1 });
  });

  it('scales the bar against the widest cell in its own row', () => {
    const row = rowOf([200, 350, 520, 700], [0.95, 0.988, 0.994, 0.998]);
    const cells = row.cells;
    expect(barPercent(row, cells[3]!)).toBe(100);
    expect(barPercent(row, cells[0]!)).toBe(29);
    // A cell with no result yet draws nothing.
    expect(barPercent(rowOf([null], [null]), rowOf([null], [null]).cells[0]!)).toBe(0);
  });
});

describe('formatting', () => {
  it('prints sizes, savings and SSIM the way the comp does', () => {
    expect(formatBytes(948)).toBe('948 B');
    expect(formatBytes(12_400)).toBe('12.4 kB');
    expect(formatBytes(null)).toBe('0 B');
    expect(formatSavedPct(38)).toBe('-38%');
    expect(formatSavedPct(-4)).toBe('+4%');
    expect(formatSavedPct(0)).toBe('0%');
    expect(formatSsim(0.9943)).toBe('0.994');
    expect(formatSsim(null)).toBe('—');
    expect(stepShortLabel(50, false)).toBe('q50');
    expect(stepShortLabel(4, true)).toBe('e4');
    expect(numberWord(20)).toBe('Twenty');
    expect(numberWord(42)).toBe('42');
    expect(joinList(['a', 'b', 'c'])).toBe('a, b and c');
  });

  it('describes only the encoders that were actually swept', () => {
    const copy = describeSweep({
      lossyLabels: ['MozJPEG', 'WebP', 'AVIF', 'JPEG XL'],
      losslessLabels: ['OxiPNG'],
      efforts: [0, 2, 4, 6],
      columnCount: 4,
      excludedLabels: ['QOI', 'Browser JPEG'],
      measured: true,
      unmeasuredFloor: 50,
    });

    expect(copy).toContain('MozJPEG, WebP, AVIF and JPEG XL at four quality steps');
    expect(copy).toContain('OxiPNG is lossless, so its columns are effort levels 0 / 2 / 4 / 6');
    expect(copy).toContain('QOI and Browser JPEG sit out of the sweep');
    expect(copy).not.toContain('No perceptual metric');
  });

  it('says out loud when SSIM is not being measured', () => {
    const copy = describeSweep({
      lossyLabels: ['AVIF'],
      losslessLabels: [],
      efforts: [],
      columnCount: 4,
      excludedLabels: [],
      measured: false,
      unmeasuredFloor: 50,
    });

    expect(copy.startsWith('Weight for AVIF')).toBe(true);
    expect(copy).toContain('No perceptual metric is wired up here');
  });
});
