/**
 * "Auto": find the smallest quality that still looks like the original.
 *
 * Pure orchestration — it encodes nothing and measures nothing itself. Both
 * capabilities arrive as injected functions, which is what makes the search
 * unit-testable with two fakes and no wasm, and what keeps this file free of
 * any import from `state/` or `codecs/`.
 *
 * ## The search
 * SSIM is monotone non-decreasing in quality for every encoder we ship, so the
 * smallest acceptable quality is a binary-search boundary: probe the midpoint,
 * and if it clears the target keep it and search lower, otherwise search
 * higher. Six probes cover the default 30–95 range to within a point or two,
 * and each probe is one encode + one measurement — the same cost as the user
 * dragging the slider six times, except they get the answer instead of an
 * afternoon.
 *
 * If nothing in range clears the target (a photo of noise, or a target set
 * absurdly high), the best probe seen is returned with `met: false` rather than
 * a rejection: the UI still has something honest to say.
 */

import { assertSignal, type MetricsResult } from '../contracts';
import { formatSsim, isVisuallyIdentical } from './verdict';
import type { MetricsImage } from './ssim';

/* -------------------------------------------------------------------------- */
/* Injected capabilities                                                       */
/* -------------------------------------------------------------------------- */

export interface AutoSuggestEncodeResult {
  /** Encoded size in bytes — the number the suggestion is sold on. */
  size: number;
  /** The encode decoded back to pixels, for the comparison. */
  data: MetricsImage;
}

/**
 * Encode the current image at one quality.
 *
 * The caller owns everything else — encoder id, resize, advanced options — by
 * closing over its session. `signal` is passed through when the caller's
 * pipeline can use it; ignoring it is fine, the search aborts either way.
 */
export type AutoSuggestEncode = (
  quality: number,
  signal?: AbortSignal,
) => Promise<AutoSuggestEncodeResult>;

/**
 * Score one encode against the original. Return the SSIM, a whole
 * {@link MetricsResult}, or `null` when it could not be measured.
 *
 * The original is the caller's business — close over it, exactly as
 * `client.measure(original, output, signal)` does.
 */
export type AutoSuggestMeasure = (
  output: MetricsImage,
  quality: number,
  signal?: AbortSignal,
) => Promise<MetricsResult | number | null>;

/** Normalise whatever {@link AutoSuggestMeasure} returned to an SSIM or `null`. */
export function ssimOf(value: MetricsResult | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ssim = typeof value === 'number' ? value : value.ssim;
  if (ssim === null || ssim === undefined || Number.isNaN(ssim)) return null;
  return ssim;
}

/* -------------------------------------------------------------------------- */
/* Search                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Defaults tuned to the comp's "AVIF at q52".
 *
 * `targetSsim` sits just above `THRESHOLDS.good` (0.985): comfortably invisible
 * without paying for the last, unseeable, tenth of a percent. The range starts
 * at 30 because below that no encoder is worth suggesting, and stops at 95
 * because 96–100 is where file size explodes for no visible gain.
 */
export const AUTO_SUGGEST_DEFAULTS = {
  targetSsim: 0.99,
  qMin: 30,
  qMax: 95,
  maxIters: 6,
} as const;

export interface SuggestQualityOptions {
  /** SSIM the encode must reach. Default {@link AUTO_SUGGEST_DEFAULTS.targetSsim}. */
  targetSsim?: number;
  /** Lowest quality worth suggesting. Default 30. */
  qMin?: number;
  /** Highest quality to try. Default 95. */
  qMax?: number;
  /** Hard cap on encode+measure rounds. Default 6. */
  maxIters?: number;
  /** Aborts the search; the in-flight encode is the caller's to cancel. */
  signal?: AbortSignal;
}

export interface QualitySuggestion {
  /** The recommended quality. */
  quality: number;
  /** Its encoded size in bytes. */
  size: number;
  /** Its SSIM, or `null` when the comparison was not possible. */
  ssim: number | null;
  /** Encode+measure rounds actually run. */
  iterations: number;
  /** True when {@link QualitySuggestion.ssim} reached `targetSsim`. */
  met: boolean;
  /** The target this search ran against, for the message. */
  targetSsim: number;
}

interface Probe {
  quality: number;
  size: number;
  ssim: number | null;
}

/**
 * Binary-search the smallest quality whose SSIM reaches `targetSsim`.
 *
 * @throws `AbortError` when `options.signal` fires, `RangeError` when the
 *         quality range is inverted. Anything the injected `encode`/`measure`
 *         throws propagates untouched.
 */
export async function suggestQuality(
  encode: AutoSuggestEncode,
  measure: AutoSuggestMeasure,
  options: SuggestQualityOptions = {},
): Promise<QualitySuggestion> {
  const targetSsim = options.targetSsim ?? AUTO_SUGGEST_DEFAULTS.targetSsim;
  const qMin = Math.round(options.qMin ?? AUTO_SUGGEST_DEFAULTS.qMin);
  const qMax = Math.round(options.qMax ?? AUTO_SUGGEST_DEFAULTS.qMax);
  if (qMax < qMin) {
    throw new RangeError(`inverted quality range: ${qMin}..${qMax}`);
  }
  // At least one probe, always — a suggestion of "nothing" helps nobody.
  const budget = Math.max(1, Math.floor(options.maxIters ?? AUTO_SUGGEST_DEFAULTS.maxIters));
  const signal = options.signal;

  const seen = new Map<number, Probe>();
  let iterations = 0;

  const probe = async (quality: number): Promise<Probe> => {
    const cached = seen.get(quality);
    if (cached) return cached;

    if (signal) assertSignal(signal);
    const { size, data } = await encode(quality, signal);
    if (signal) assertSignal(signal);
    const measured = await measure(data, quality, signal);
    if (signal) assertSignal(signal);

    const result: Probe = { quality, size, ssim: ssimOf(measured) };
    seen.set(quality, result);
    iterations++;
    return result;
  };

  /** Smallest quality found so far that clears the target. */
  let best: Probe | null = null;
  /** Best failure, for the honest fallback: highest SSIM, then lowest quality. */
  let closest: Probe | null = null;

  let lo = qMin;
  let hi = qMax;

  while (lo <= hi && iterations < budget) {
    const mid = Math.floor((lo + hi) / 2);
    const result = await probe(mid);

    if (result.ssim !== null && result.ssim >= targetSsim) {
      best = result;
      hi = mid - 1;
    } else {
      lo = mid + 1;
      // `>=` on purpose: when scores tie (or nothing is measurable) the search
      // has been walking upwards, so the last probe is the highest quality
      // tried — the safer thing to offer when the target was never reached.
      if (!closest || (result.ssim ?? -1) >= (closest.ssim ?? -1)) closest = result;
    }
  }

  const chosen = best ?? closest;
  if (!chosen) {
    // Unreachable: the loop always runs at least once (qMin <= qMax, budget >= 1).
    throw new Error('auto-suggest ran no probes');
  }

  return {
    quality: chosen.quality,
    size: chosen.size,
    ssim: chosen.ssim,
    iterations,
    met: best !== null,
    targetSsim,
  };
}

/* -------------------------------------------------------------------------- */
/* Message                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * SI file size — `948 B`, `390 kB`, `2.92 MB`.
 *
 * Deliberately duplicated from `batch/format.ts` (same algorithm, same output)
 * so the metrics module has no dependency on a sibling feature directory.
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'] as const;
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }

  const digits = unit === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit] ?? 'B'}`;
}

/** Whole-percent share of the original the output still weighs. */
export function percentOfOriginal(originalBytes: number, outputBytes: number): number {
  if (originalBytes <= 0) return 0;
  return Math.round((outputBytes / originalBytes) * 100);
}

export interface DescribeSuggestionOptions {
  /** Display name of the encoder under test, e.g. `AVIF`. */
  encoderLabel?: string;
  /** Source file size, for the "13% of the original weight" clause. */
  originalBytes?: number;
}

/**
 * The Auto pill's sentence:
 * `AVIF at q52 is visually identical — 13% of the original weight`.
 *
 * Falls back to the absolute size when the original's weight is unknown, and
 * says what actually happened when the target was not reached.
 */
export function describeSuggestion(
  suggestion: QualitySuggestion,
  options: DescribeSuggestionOptions = {},
): string {
  const label = options.encoderLabel?.trim() || 'This encoder';
  const head = `${label} at q${suggestion.quality}`;

  const verdict = suggestion.met
    ? isVisuallyIdentical(suggestion.ssim)
      ? 'is visually identical'
      : `reaches SSIM ${formatSsim(suggestion.ssim)}`
    : suggestion.ssim === null
      ? 'is the smallest we could check'
      : `is as close as it gets — SSIM ${formatSsim(suggestion.ssim)}`;

  const weight = weightClause(suggestion.size, options.originalBytes);
  return weight ? `${head} ${verdict} — ${weight}` : `${head} ${verdict}`;
}

function weightClause(size: number, originalBytes: number | undefined): string {
  if (originalBytes !== undefined && originalBytes > 0) {
    const percent = percentOfOriginal(originalBytes, size);
    return percent < 1
      ? 'under 1% of the original weight'
      : `${percent}% of the original weight`;
  }
  return size > 0 ? formatBytes(size) : '';
}
