/**
 * Turning an SSIM number into words: the green caption under the editor's SSIM
 * cell ("Below visible threshold"), the mobile one-liner ("Looks identical"),
 * and the accent every screen paints them with.
 *
 * The cut points are **not** redefined here — {@link THRESHOLDS} in
 * `contracts/pinch.ts` is the single source of truth, and `verdictFor` (the
 * matrix's outline pill: Excellent / Good / Soft / …) is re-exported from there
 * unchanged so a screen only ever needs one import.
 *
 * Pure, no DOM, no reactivity.
 */

import { THRESHOLDS, type Verdict, type VerdictTone } from '../contracts';

export { THRESHOLDS, verdictFor } from '../contracts';
export type { Verdict, VerdictTone } from '../contracts';

/**
 * Accent name for a tone, in `AccentName` terms so it can be handed straight to
 * `Chip`, `BrandDot` or `accentText()` from `$lib/ui`.
 */
export type MetricsAccent = 'green' | 'yellow' | 'red' | 'muted';

/** Good is green, ok is yellow, warn is red — the comp's three states. */
export function toneAccent(tone: VerdictTone): MetricsAccent {
  switch (tone) {
    case 'good':
      return 'green';
    case 'ok':
      return 'yellow';
    case 'warn':
      return 'red';
  }
}

/** Accent for a whole verdict, e.g. a matrix cell's pill. */
export function verdictAccent(verdict: Verdict): MetricsAccent {
  return toneAccent(verdict.tone);
}

/**
 * The sentence under the SSIM figure.
 *
 * `label` is the desktop caption (editor toolbar, 9px mono caps); `short` is
 * the 390px variant, which has room for two words. Both are stored in sentence
 * case — uppercasing is the stylesheet's job.
 */
export interface MetricsCaption {
  label: string;
  short: string;
  tone: VerdictTone;
  accent: MetricsAccent;
}

type CaptionKey =
  | 'unmeasured'
  | 'identical'
  | 'invisible'
  | 'safe'
  | 'minor'
  | 'visible'
  | 'heavy';

const CAPTIONS: Readonly<Record<CaptionKey, Omit<MetricsCaption, 'accent'>>> = {
  unmeasured: { label: 'Not measured', short: 'Unmeasured', tone: 'ok' },
  identical: { label: 'Mathematically identical', short: 'Identical', tone: 'good' },
  invisible: { label: 'Below visible threshold', short: 'Looks identical', tone: 'good' },
  safe: { label: 'Looks identical', short: 'Looks identical', tone: 'good' },
  minor: { label: 'Minor loss on gradients', short: 'Minor loss', tone: 'ok' },
  visible: { label: 'Visible loss', short: 'Visible loss', tone: 'warn' },
  heavy: { label: 'Heavy loss', short: 'Heavy loss', tone: 'warn' },
};

function caption(key: CaptionKey): MetricsCaption {
  const base = CAPTIONS[key];
  return {
    ...base,
    // "Not measured" is a state, not a judgement — it stays muted ink.
    accent: key === 'unmeasured' ? 'muted' : toneAccent(base.tone),
  };
}

/**
 * SSIM → caption. `null` (Resize on, aborted, still in flight) is reported as
 * "Not measured" in muted ink rather than guessed at.
 */
export function captionFor(ssim: number | null): MetricsCaption {
  if (ssim === null || Number.isNaN(ssim)) return caption('unmeasured');
  if (ssim >= THRESHOLDS.lossless) return caption('identical');
  if (ssim >= THRESHOLDS.excellent) return caption('invisible');
  if (ssim >= THRESHOLDS.good) return caption('safe');
  if (ssim >= THRESHOLDS.soft) return caption('minor');
  if (ssim >= THRESHOLDS.visible) return caption('visible');
  return caption('heavy');
}

/**
 * True when the encode is at or above the "safe default" cut point — the test
 * behind "is visually identical" in the Auto pill.
 */
export function isVisuallyIdentical(ssim: number | null): boolean {
  return ssim !== null && !Number.isNaN(ssim) && ssim >= THRESHOLDS.good;
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

/** Em dash for "no number", so a missing value never renders as `null`. */
export const NO_VALUE = '—';

/** `0.994`, or `—` when unmeasured. Three decimals, as in every comp. */
export function formatSsim(ssim: number | null | undefined, digits = 3): string {
  if (ssim === null || ssim === undefined || Number.isNaN(ssim)) return NO_VALUE;
  return ssim.toFixed(digits);
}

/**
 * No butteraugli implementation ships in this build — the comp's Butteraugli
 * row renders `—`. Kept as a named constant so the screens' choice is explicit
 * rather than an accident, and so adding the metric later is a one-line flip.
 */
export const BUTTERAUGLI_SUPPORTED = false;

/** `1.2`, or `—` when the metric was not measured. Lower is better. */
export function formatButteraugli(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return NO_VALUE;
  return value.toFixed(digits);
}
