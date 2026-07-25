/**
 * Presentation helpers for the editor toolbar. Pure functions, no DOM — every
 * number the toolbar prints is formatted in exactly one place, so the mobile
 * sheet and the desktop bar can never disagree.
 *
 * Deliberately self-contained (it duplicates `batch/format.ts`'s SI byte
 * formatter rather than importing it) so the options module keeps depending on
 * `contracts/` alone.
 */

import { savingsPct } from '../contracts';

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const;

/**
 * File size in SI units, matching the comp: `2.92 MB`, `390 kB`, `948 B`.
 * Precision shrinks as the number grows.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }

  const digits = unit === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toFixed(digits)} ${UNITS[unit] ?? 'B'}`;
}

/** `4032 × 3024` — the multiplication sign, not a lowercase x. */
export function formatDimensions(width: number, height: number): string {
  return `${Math.round(width)} × ${Math.round(height)}`;
}

/** The source cell's second line: `2.92 MB · 4032 × 3024`. */
export function formatSource(bytes: number, width: number, height: number): string {
  return `${formatBytes(bytes)} · ${formatDimensions(width, height)}`;
}

/**
 * Signed saving against the original, with the comp's typographic minus:
 * `−87%` for a saving, `+4%` when the encode grew, `0%` when it broke even.
 */
export function formatSavings(originalBytes: number, outputBytes: number): string {
  const percent = savingsPct(originalBytes, outputBytes);
  if (percent === 0) return '0%';
  return percent > 0 ? `−${percent}%` : `+${Math.abs(percent)}%`;
}

/** `2.53 MB saved` — or `120 kB larger` when the encode went the wrong way. */
export function formatDelta(originalBytes: number, outputBytes: number): string {
  const delta = originalBytes - outputBytes;
  if (delta === 0) return 'same size';
  return delta > 0 ? `${formatBytes(delta)} saved` : `${formatBytes(-delta)} larger`;
}

/** SSIM to three decimals; `—` when the metric could not be computed. */
export function formatSsim(ssim: number | null | undefined): string {
  if (ssim === null || ssim === undefined || Number.isNaN(ssim)) return '—';
  return ssim.toFixed(3);
}

/** Trailing zeros are noise on a 0.1-step slider: `75`, not `75.0`. */
export function formatQuality(value: number, step: number): string {
  if (Number.isInteger(value)) return String(value);
  return step < 1 ? value.toFixed(1) : String(Math.round(value));
}
