/**
 * Contracts for the "Pinch — Editorial" shell: views, tabs, metrics verdicts,
 * the codec matrix sweep, and app-level settings.
 *
 * Additive on top of the existing contracts — nothing here replaces
 * `processing.ts` / `jobs.ts` / `batch.ts`, it only describes the new UI
 * surfaces that sit on them.
 *
 * Dependency-free, like the rest of `contracts/`: types plus a handful of pure
 * helpers, no runtime imports outside this directory. In particular a tab's
 * `session` is typed as the {@link JobEngine} *interface*, not the concrete
 * `JobSession` class in `state/` — contracts must never depend on state.
 */

import type { EncoderId } from './codecs';
import type { JobEngine } from './jobs';
import type { SideSettings } from './processing';

/* -------------------------------------------------------------------------- */
/* Views                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Top-level screen, one per comp in `design-ref/pinch-editorial.html`.
 *
 * - `home`     — 01, the drop zone, shown while no tab is open
 * - `editor`   — 02/02b, one image, reveal compare + single toolbar
 * - `matrix`   — 03, every encoder × quality for the active tab
 * - `queue`    — 04, batch encode
 * - `settings` — 05
 * - `pdf`      — no comp: one PDF, analysis + recompress. Has no tab and no
 *   nav link, because a PDF is not an image and never joins the tab strip; the
 *   only way in is dropping/picking a PDF, and the only way out is its Close ×.
 *
 * Distinct from the legacy `AppMode` in `./index.ts`, which only knew
 * intro/editor/batch.
 */
export type AppView = 'home' | 'editor' | 'matrix' | 'queue' | 'settings' | 'pdf';

export const APP_VIEWS: readonly AppView[] = [
  'home',
  'editor',
  'matrix',
  'queue',
  'settings',
  'pdf',
];

export function isAppView(value: unknown): value is AppView {
  return typeof value === 'string' && (APP_VIEWS as readonly string[]).includes(value);
}

/**
 * The views reachable from the top bar once at least one tab is open.
 * Deliberately shorter than {@link APP_VIEWS}: `pdf` is entered by file intake
 * only, so putting it in the nav would offer a screen with nothing to show.
 */
export const NAV_VIEWS: readonly AppView[] = ['matrix', 'queue', 'settings'];

/* -------------------------------------------------------------------------- */
/* Tabs                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One open image. Each tab owns its own engine, so switching tabs never
 * re-decodes and in-flight encodes keep running in the background.
 */
export interface TabState {
  /** Stable across the tab's life; use as the `{#each}` key. */
  readonly id: string;
  /** The source file, as dropped/picked. Never the encoded output. */
  readonly file: File;
  /** This tab's engine. Side 0 is pinned to `identity`; side 1 is the user's. */
  readonly session: JobEngine;
  /** True once the user has changed anything away from the defaults. */
  dirty: boolean;
}

/**
 * Tab strip + active-tab store, implemented in the state layer as a
 * `.svelte.ts` singleton. Every getter is reactive; every method is
 * synchronous.
 */
export interface TabsApi {
  /** Open tabs, in strip order. */
  readonly tabs: readonly TabState[];
  /** `null` only when {@link TabsApi.tabs} is empty. */
  readonly activeId: string | null;
  /** Convenience for `tabs.find(t => t.id === activeId)`. */
  readonly active: TabState | null;

  /** Open one file in a new tab, activate it, and return its id. */
  open(file: File): string;
  /** Open many; the first becomes active. Returns the new ids, in order. */
  openMany(files: readonly File[]): readonly string[];
  activate(id: string): void;
  /** Dispose the tab's engine and activate its neighbour. */
  close(id: string): void;
  /** Dispose every engine. Used when the user goes back to `home`. */
  closeAll(): void;
  markDirty(id: string, dirty: boolean): void;
}

/** Beyond this the tab strip scrolls rather than shrinking further. */
export const MAX_VISIBLE_TABS = 8;

/* -------------------------------------------------------------------------- */
/* Metrics & verdicts                                                          */
/* -------------------------------------------------------------------------- */

/** Outcome of comparing an encode against the original. */
export interface MetricsResult {
  /**
   * Structural similarity, 0–1. `null` when it could not be computed — the
   * dimensions differ (resize on), the comparison was aborted, or the metric
   * is still in flight.
   */
  ssim: number | null;
  /** Wall-clock cost of the measurement, ms. */
  ms: number;
  /**
   * Butteraugli distance (lower is better). Optional: not every build ships
   * the metric, and `undefined` means "not measured", not "identical".
   */
  butteraugli?: number | null;
}

export type VerdictTone = 'good' | 'ok' | 'warn';

/** A human call on an encode, rendered as the outline pill in the matrix. */
export interface Verdict {
  /** Short caps label: `Recommended`, `Good`, `Soft`, `Overkill`… */
  label: string;
  tone: VerdictTone;
}

/**
 * SSIM cut points behind {@link verdictFor}. Tuned to the comp's numbers:
 * 0.999 reads "Overkill", 0.994 "Excellent", 0.991 "Good", 0.961 "Soft".
 */
export const THRESHOLDS = {
  /** Mathematically identical — lossless codecs land here. */
  lossless: 1,
  /** Above this the encoder is spending bytes nobody can see. */
  overkill: 0.998,
  /** Comfortably invisible at 100%. */
  excellent: 0.994,
  /** Invisible in normal viewing; the safe default target. */
  good: 0.985,
  /** Softness shows on flat gradients and skies. */
  soft: 0.96,
  /** Below this, damage is visible without looking for it. */
  visible: 0.94,
  /** A saving smaller than this is not worth changing format for, in %. */
  savingsFloor: 5,
} as const;

/**
 * Map an SSIM score onto the verdict pill. `null` (unmeasurable) is reported
 * honestly rather than guessed at.
 */
export function verdictFor(ssim: number | null): Verdict {
  if (ssim === null || Number.isNaN(ssim)) return { label: 'Unmeasured', tone: 'ok' };
  if (ssim >= THRESHOLDS.lossless) return { label: 'Lossless', tone: 'good' };
  if (ssim >= THRESHOLDS.overkill) return { label: 'Overkill', tone: 'ok' };
  if (ssim >= THRESHOLDS.excellent) return { label: 'Excellent', tone: 'good' };
  if (ssim >= THRESHOLDS.good) return { label: 'Good', tone: 'good' };
  if (ssim >= THRESHOLDS.soft) return { label: 'Soft', tone: 'ok' };
  if (ssim >= THRESHOLDS.visible) return { label: 'Watch skies', tone: 'warn' };
  return { label: 'Visible loss', tone: 'warn' };
}

/**
 * Percentage saved against the original, rounded to a whole number.
 * Negative when the "compressed" file grew. `0` when the original is empty.
 */
export function savingsPct(originalBytes: number, outputBytes: number): number {
  if (originalBytes <= 0) return 0;
  return Math.round(((originalBytes - outputBytes) / originalBytes) * 100);
}

/* -------------------------------------------------------------------------- */
/* Codec matrix                                                                */
/* -------------------------------------------------------------------------- */

/** Column headings of the sweep — "Quality 30/50/70/90" in the comp. */
export const MATRIX_QUALITY_STEPS: readonly number[] = [30, 50, 70, 90];

/**
 * Rows of the sweep, in comp order. Browser JPEG/PNG, QOI and WebP v2 sit it
 * out (no meaningful quality axis, or no wasm build) and stay pickable from
 * the encoder list instead.
 */
export const MATRIX_ENCODERS: readonly EncoderId[] = [
  'mozjpeg',
  'webp',
  'avif',
  'jxl',
  'oxipng',
];

export interface MatrixSweepRequest {
  /** Encoders to sweep, one row each, in order. */
  encoders: readonly EncoderId[];
  /**
   * Quality steps, one column each, in order. For lossless encoders
   * (`oxipng`) these are read as effort levels — the comp says so out loud.
   */
  qualities: readonly number[];
  /** Size of the source file, for the savings figures. */
  originalBytes: number;
  /** Compute SSIM per cell. Expensive; off means every cell's ssim is `null`. */
  measure?: boolean;
  /** Cancels the whole sweep. Partial rows already emitted stay on screen. */
  signal?: AbortSignal;
}

/** One encoder × one quality step. */
export interface MatrixCell {
  /** Encoded size in bytes. `null` while the cell is still encoding. */
  size: number | null;
  /** Whole-percent saving against the original; see {@link savingsPct}. */
  savedPct: number;
  /** `null` when unmeasured — see {@link MetricsResult.ssim}. */
  ssim: number | null;
  verdict: Verdict;
  /** Exactly one cell in the whole sweep is the recommendation. */
  recommended: boolean;
  /** Ready to hand straight to `JobEngine.updateSide(1, …)`. */
  settings: SideSettings;
  /** Set when this cell failed; `size` stays `null`. */
  error?: string;
}

export interface MatrixRow {
  encoderId: EncoderId;
  /** Display name, e.g. `MozJPEG`. */
  label: string;
  /** Single letter for the row badge. */
  initial: string;
  /** Sub-label: "Wide support · smaller than JPEG". */
  note: string;
  /** Badge colour — one of the five accents, as a CSS colour string. */
  accent: string;
  /** One per entry of {@link MatrixSweepRequest.qualities}. */
  cells: readonly MatrixCell[];
}

export interface MatrixSweepResult {
  rows: readonly MatrixRow[];
  /** Total cells encoded — "20 encodes · 7.2 s on 8 threads". */
  encodes: number;
  /** Wall-clock duration of the whole sweep, ms. */
  ms: number;
  /** Row/column of the recommended cell, or `null` if nothing qualified. */
  recommended: { encoderId: EncoderId; quality: number } | null;
}

/* -------------------------------------------------------------------------- */
/* App settings                                                                */
/* -------------------------------------------------------------------------- */

/** Persisted, app-wide preferences — screen 05. */
export interface AppSettings {
  /** Applied the moment a file lands, before the user touches anything. */
  defaultEncoder: EncoderId;
  /** Off strips camera, location and copyright tags from the output. */
  keepExif: boolean;
  /** Codec worker pool size. */
  workerThreads: number;
}

/** Bounds for the worker-threads slider. */
export const WORKER_THREADS_RANGE = { min: 1, max: 16, step: 1 } as const;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultEncoder: 'avif',
  keepExif: false,
  workerThreads: 4,
};

/** Fresh, mutable copy — safe to hand to `$state`. */
export function createDefaultAppSettings(): AppSettings {
  return { ...DEFAULT_APP_SETTINGS };
}

/** Left-hand nav of the settings screen, in comp order. */
export type SettingsSectionId =
  | 'defaults'
  | 'encoders'
  | 'presets'
  | 'metrics'
  | 'shortcuts'
  | 'about';

export const SETTINGS_SECTIONS: readonly SettingsSectionId[] = [
  'defaults',
  'encoders',
  'presets',
  'metrics',
  'shortcuts',
  'about',
];
