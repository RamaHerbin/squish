/**
 * Metrics: the SSIM number, the words for it, and the auto-suggest search.
 *
 * ```ts
 * import {
 *   getSharedMetricsClient, captionFor, formatSsim, AutoSuggestController,
 * } from '$lib/metrics';
 * ```
 *
 * Three layers, each usable on its own:
 * - `ssim.ts` — the pure metric. No DOM, no worker; safe anywhere.
 * - `metrics.worker.ts` + `metrics-client.ts` — the same metric off the main
 *   thread, with the codec bridge's lazy-spawn / serialise / abort-is-terminate
 *   behaviour.
 * - `auto-suggest.ts` + `AutoSuggestController.svelte.ts` — the binary search
 *   behind the Auto pill, with encode and measure injected by the caller.
 *
 * Nothing here imports `state/` or `codecs/`.
 */

export {
  METRICS_MAX_PIXELS,
  SSIM_K1,
  SSIM_K2,
  SSIM_L,
  SSIM_STRIDE,
  SSIM_WINDOW,
  assertComparable,
  computeSsim,
  downscaleBy,
  downscaleForMetrics,
  downscalePairForMetrics,
  measureSsim,
  metricsScaleFactor,
  sameDimensions,
  ssimOfLuma,
  toLuma,
} from './ssim';
export type { MetricsImage } from './ssim';

export {
  METRICS_IDLE_TIMEOUT_MS,
  MetricsClient,
  createMetricsClient,
  disposeSharedMetricsClient,
  getSharedMetricsClient,
} from './metrics-client';
export type { MetricsClientOptions, MetricsMeasurement } from './metrics-client';

// Types only: the worker module is loaded *as a worker* by the client, and
// pulling its body into the app bundle through this barrel would give Vite two
// copies of it. `handleMetricsRequest` is importable directly from
// './metrics.worker' when a caller genuinely wants the synchronous path.
export type {
  MetricsFailure,
  MetricsRequest,
  MetricsResponse,
  MetricsSuccess,
} from './metrics.worker';

export {
  BUTTERAUGLI_SUPPORTED,
  NO_VALUE,
  THRESHOLDS,
  captionFor,
  formatButteraugli,
  formatSsim,
  isVisuallyIdentical,
  toneAccent,
  verdictAccent,
  verdictFor,
} from './verdict';
export type { MetricsAccent, MetricsCaption, Verdict, VerdictTone } from './verdict';

export {
  AUTO_SUGGEST_DEFAULTS,
  describeSuggestion,
  formatBytes,
  percentOfOriginal,
  ssimOf,
  suggestQuality,
} from './auto-suggest';
export type {
  AutoSuggestEncode,
  AutoSuggestEncodeResult,
  AutoSuggestMeasure,
  DescribeSuggestionOptions,
  QualitySuggestion,
  SuggestQualityOptions,
} from './auto-suggest';

export {
  AutoSuggestController,
  createAutoSuggestController,
} from './AutoSuggestController.svelte';
export type {
  AutoSuggestControllerOptions,
  AutoSuggestState,
} from './AutoSuggestController.svelte';
