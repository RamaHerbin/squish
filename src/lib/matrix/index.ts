/**
 * Screen 03 — the codec matrix.
 *
 * ```svelte
 * import { MatrixView } from '$lib/matrix';
 * ```
 *
 * `MatrixView.svelte` is the whole screen body (the shell owns the 56px top
 * bar). `sweep.svelte.ts` is the engine behind it and has no DOM dependency,
 * so it can be driven from a test or reused headlessly.
 */

export { default as MatrixView } from './MatrixView.svelte';

export {
  ELAPSED_TICK_MS,
  MATRIX_EFFORT_STEPS,
  MAX_MATRIX_CONCURRENCY,
  UNMEASURED_QUALITY_FLOOR,
  barPercent,
  createMatrixSweep,
  isLosslessSweepRow,
  pickRecommended,
  recommendedMatrixConcurrency,
  rowMaxSize,
  runMatrixSweep,
  settingsForStep,
  stepLabelFor,
  stepsFor,
} from './sweep.svelte';

export type {
  MatrixCellStatus,
  MatrixColumn,
  MatrixMetricsFn,
  MatrixRunOptions,
  MatrixSweepCell,
  MatrixSweepOptions,
  MatrixSweepRow,
  MatrixSweepStore,
} from './sweep.svelte';

export {
  describeSweep,
  formatBytes,
  formatSavedPct,
  formatSeconds,
  formatSsim,
  joinList,
  numberWord,
  stepShortLabel,
} from './format';

export type { SweepCopyInput } from './format';
