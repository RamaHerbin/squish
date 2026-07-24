/**
 * The Auto pill's brain: one controller per editor tab.
 *
 * ```
 * ┌──────┬─────────────────────────────────────────────────────────┬─────────┐
 * │ AUTO │ AVIF at q52 is visually identical — 13% of the original… │ APPLIED │
 * └──────┴─────────────────────────────────────────────────────────┴─────────┘
 * ```
 *
 * It owns the *state* of a suggestion — running / done / failed, the sentence,
 * whether the user took it — and nothing else. The encode and the measurement
 * are injected, so this file imports neither `state/` nor `codecs/` and can be
 * driven in a test by two fakes.
 *
 * ## Usage
 * ```ts
 * const auto = new AutoSuggestController({
 *   encodeAt: (q) => session.encodeProbe(q),         // your pipeline
 *   measure: (data) => metrics.measure(original, data),
 *   encoderLabel: () => encoderMeta.label,
 *   originalBytes: () => tab.file.size,
 *   onApply: (s) => session.updateSide(1, withQuality(settings, s.quality)),
 * });
 *
 * // in the screen
 * $effect(() => { if (settings.autoSuggest) void auto.run(); });
 * $effect(() => () => auto.dispose());
 * ```
 *
 * Every field is a rune, so `auto.message` in markup re-renders on its own.
 * Runs supersede each other: calling {@link AutoSuggestController.run} again
 * aborts the one in flight, and a late result from a superseded run is dropped
 * rather than flashing on screen.
 */

import { isAbortError } from '../contracts';
import {
  describeSuggestion,
  suggestQuality,
  type AutoSuggestEncode,
  type AutoSuggestMeasure,
  type QualitySuggestion,
} from './auto-suggest';

export type AutoSuggestState = 'idle' | 'running' | 'done' | 'error';

export interface AutoSuggestControllerOptions {
  /** Encode the current image at one quality. See {@link AutoSuggestEncode}. */
  encodeAt: AutoSuggestEncode;
  /** Score an encode against the original. See {@link AutoSuggestMeasure}. */
  measure: AutoSuggestMeasure;
  /** Current encoder's display name, read reactively for the message. */
  encoderLabel?: () => string;
  /** Source file size, read reactively for the "% of the original" clause. */
  originalBytes?: () => number;
  /** Called by {@link AutoSuggestController.apply} — write the quality here. */
  onApply?: (suggestion: QualitySuggestion) => void;
  /** Search overrides; see `AUTO_SUGGEST_DEFAULTS`. */
  targetSsim?: number;
  qMin?: number;
  qMax?: number;
  maxIters?: number;
}

export class AutoSuggestController {
  /** Lifecycle of the current suggestion. */
  state = $state<AutoSuggestState>('idle');
  /** The result of the last completed run; survives a later cancel. */
  suggestion = $state<QualitySuggestion | null>(null);
  /** Set only in the `error` state. */
  error = $state<string | null>(null);
  /** Quality currently being encoded, for the "Testing q62…" line. */
  probing = $state<number | null>(null);
  /** True once {@link AutoSuggestController.apply} has run for this suggestion. */
  applied = $state(false);

  readonly #options: AutoSuggestControllerOptions;
  #controller: AbortController | null = null;
  #runId = 0;

  constructor(options: AutoSuggestControllerOptions) {
    this.#options = options;
  }

  /* ---------------------------------------------------------------------- */
  /* Derived copy                                                            */
  /* ---------------------------------------------------------------------- */

  /** The pill's sentence, or `null` when there is nothing to say yet. */
  message = $derived.by((): string | null => {
    switch (this.state) {
      case 'running':
        return this.probing === null
          ? 'Looking for the smallest quality that still looks identical…'
          : `Testing q${this.probing}…`;
      case 'error':
        return this.error ?? 'Auto-suggest could not finish';
      case 'done':
        return this.suggestion
          ? describeSuggestion(this.suggestion, {
              encoderLabel: this.#options.encoderLabel?.(),
              originalBytes: this.#options.originalBytes?.(),
            })
          : null;
      case 'idle':
        return null;
    }
  });

  /** Right-hand cell of the pill: `Applied`, `Apply`, `Cancel` or `Retry`. */
  actionLabel = $derived.by((): string | null => {
    switch (this.state) {
      case 'running':
        return 'Cancel';
      case 'error':
        return 'Retry';
      case 'done':
        return this.applied ? 'Applied' : 'Apply';
      case 'idle':
        return null;
    }
  });

  /** Whether the pill should be on screen at all. */
  visible = $derived(this.state !== 'idle');

  get busy(): boolean {
    return this.state === 'running';
  }

  /* ---------------------------------------------------------------------- */
  /* Commands                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Run the search. Aborts any run already in flight.
   *
   * Never rejects: a failure lands in {@link AutoSuggestController.error} and
   * the `error` state, because a suggestion is an offer, not a job.
   *
   * @returns the suggestion, or `null` if it failed, was aborted or superseded.
   */
  async run(): Promise<QualitySuggestion | null> {
    this.cancel();

    const controller = new AbortController();
    this.#controller = controller;
    const runId = ++this.#runId;

    this.state = 'running';
    this.error = null;
    this.applied = false;
    this.probing = null;

    const encodeAt: AutoSuggestEncode = (quality, signal) => {
      if (this.#runId === runId) this.probing = quality;
      return this.#options.encodeAt(quality, signal);
    };

    try {
      const suggestion = await suggestQuality(encodeAt, this.#options.measure, {
        targetSsim: this.#options.targetSsim,
        qMin: this.#options.qMin,
        qMax: this.#options.qMax,
        maxIters: this.#options.maxIters,
        signal: controller.signal,
      });

      if (runId !== this.#runId) return null;
      this.suggestion = suggestion;
      this.probing = null;
      this.state = 'done';
      return suggestion;
    } catch (error) {
      if (runId !== this.#runId) return null;
      this.probing = null;
      if (isAbortError(error)) {
        // Same rule as `cancel`: an abort falls back to whatever was already
        // on screen, rather than blanking a perfectly good older suggestion.
        this.state = this.suggestion ? 'done' : 'idle';
        return null;
      }
      this.error = error instanceof Error ? error.message : String(error);
      this.state = 'error';
      return null;
    } finally {
      if (this.#controller === controller) this.#controller = null;
    }
  }

  /** Abort the run in flight. The last completed suggestion is kept. */
  cancel(): void {
    const controller = this.#controller;
    this.#controller = null;
    if (this.state === 'running') this.state = this.suggestion ? 'done' : 'idle';
    this.probing = null;
    controller?.abort();
  }

  /** Hand the suggestion to `onApply` and mark the pill as taken. */
  apply(): QualitySuggestion | null {
    const suggestion = this.suggestion;
    if (!suggestion) return null;
    this.applied = true;
    this.#options.onApply?.(suggestion);
    return suggestion;
  }

  /** Back to a blank slate — new file, new encoder, dismissed pill. */
  reset(): void {
    this.cancel();
    this.suggestion = null;
    this.error = null;
    this.applied = false;
    this.probing = null;
    this.state = 'idle';
  }

  /** Tear down with the component that owns it. */
  dispose(): void {
    this.#runId++;
    this.cancel();
  }
}

/** Convenience factory, for symmetry with `createJobSession`. */
export function createAutoSuggestController(
  options: AutoSuggestControllerOptions,
): AutoSuggestController {
  return new AutoSuggestController(options);
}
