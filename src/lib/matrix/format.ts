/**
 * Presentation helpers for the codec matrix. Pure functions, no DOM and no
 * runes — every number in `MatrixView.svelte` is formatted in exactly one
 * place, and the explainer copy is *derived from the sweep* rather than
 * hard-coded, so it can never claim to have swept an encoder it did not.
 *
 * `formatBytes` intentionally mirrors `batch/format.ts` byte-for-byte: sizes
 * must read identically in the matrix and in the queue, and copying ten lines
 * is cheaper than coupling two independently-owned modules.
 */

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const;

/**
 * File size in SI units, matching what the OS file browser shows.
 * Precision shrinks as the number grows: `948 B`, `12.4 kB`, `1.2 MB`.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }

  const digits = unit === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toFixed(digits)} ${UNITS[unit] ?? 'B'}`;
}

/**
 * Whole-percent saving as the matrix prints it: `-38%` when the encode is
 * smaller, `+4%` when it grew, `0%` when it broke even.
 */
export function formatSavedPct(savedPct: number): string {
  if (!Number.isFinite(savedPct) || savedPct === 0) return '0%';
  return savedPct > 0 ? `-${savedPct}%` : `+${Math.abs(savedPct)}%`;
}

/** SSIM to three decimals; an em dash when it was never measured. */
export function formatSsim(ssim: number | null): string {
  if (ssim === null || !Number.isFinite(ssim)) return '—';
  return ssim.toFixed(3);
}

/** Wall-clock seconds with one decimal, for `7.2 s`. */
export function formatSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0.0';
  return (ms / 1000).toFixed(1);
}

/** `q50` for a quality step, `e4` for an OxiPNG effort level. */
export function stepShortLabel(step: number, lossless: boolean): string {
  return `${lossless ? 'e' : 'q'}${step}`;
}

const WORDS = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
  'Twenty',
] as const;

/**
 * Small integers as words, so the headline reads "Twenty encodes, one look."
 * for the default 5 × 4 sweep and stays truthful for any other shape.
 */
export function numberWord(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value >= WORDS.length) return String(value);
  return WORDS[value] ?? String(value);
}

/** `['a']` → `a`; `['a','b']` → `a and b`; `['a','b','c']` → `a, b and c`. */
export function joinList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  const head = items.slice(0, -1).join(', ');
  return `${head} and ${items[items.length - 1] ?? ''}`;
}

export interface SweepCopyInput {
  /** Labels of the encoders swept on a quality axis. */
  lossyLabels: readonly string[];
  /** Labels of the lossless encoders, whose columns are effort levels. */
  losslessLabels: readonly string[];
  /** The effort levels those columns actually use. */
  efforts: readonly number[];
  /** How many columns the table has. */
  columnCount: number;
  /** Encoders that are pickable in the editor but sit out of the sweep. */
  excludedLabels: readonly string[];
  /** True when a perceptual metric is wired up and SSIM is really measured. */
  measured: boolean;
  /** Quality floor used for the recommendation when SSIM is unavailable. */
  unmeasuredFloor: number;
}

/**
 * The explainer paragraph under the headline. Every clause is conditional on
 * what the sweep actually did — the comp's static copy mentioned a "WebP v2"
 * that squish does not ship, and this is the honest version of it.
 */
export function describeSweep(input: SweepCopyInput): string {
  const sentences: string[] = [];
  const metric = input.measured ? 'Weight and SSIM' : 'Weight';

  if (input.lossyLabels.length > 0) {
    sentences.push(
      `${metric} for ${joinList(input.lossyLabels)} at ${numberWord(
        input.columnCount,
      ).toLowerCase()} quality steps.`,
    );
  } else {
    sentences.push(`${metric} for every encoder in the sweep.`);
  }

  if (input.losslessLabels.length > 0 && input.efforts.length > 0) {
    const plural = input.losslessLabels.length > 1;
    sentences.push(
      `${joinList(input.losslessLabels)} ${plural ? 'are' : 'is'} lossless, so ${
        plural ? 'their' : 'its'
      } columns are effort levels ${input.efforts.join(' / ')} instead.`,
    );
  }

  if (input.excludedLabels.length > 0) {
    sentences.push(
      `${joinList(
        input.excludedLabels,
      )} sit out of the sweep — pick them from the encoder list.`,
    );
  }

  if (!input.measured) {
    sentences.push(
      `No perceptual metric is wired up here, so every verdict reads Unmeasured and the pick falls back to the smallest encode at quality ${input.unmeasuredFloor} or better.`,
    );
  }

  return sentences.join(' ');
}
