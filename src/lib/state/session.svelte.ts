/**
 * The editor session: `JobEngine` from the contracts, implemented as a Svelte 5
 * runes store.
 *
 * ## What the UI sees
 * `session.state` is a deep `$state` object, so a component reading
 * `session.state.sides[1].loading` re-renders when exactly that changes. Every
 * mutator is synchronous and returns void — they only ever *schedule* work.
 *
 * ## Two clocks per side
 * `latestSettings` is what the user has asked for; `encodedSettings` is what
 * produced the pixels currently on screen. The UI must describe pixels with
 * `encodedSettings` and the controls with `latestSettings`; the gap between them
 * is the loading affordance. This is the single most important thing this file
 * gets right, and the reason results never appear to belong to settings that
 * have since changed.
 *
 * ## Reactive vs. bookkeeping state
 * Only display state lives in `$state`. Job snapshots, abort controllers, the
 * decoded/preprocessed/processed `ImageData`, and the result cache are private
 * class fields, deliberately *outside* the proxy: the result cache matches
 * preprocessed pixels by identity, and a `$state` proxy would hand out a
 * different wrapper each time and quietly destroy that.
 *
 * ## Aborting
 * One controller for shared work (decode + preprocess), one per side (process +
 * encode). Changing side 1's quality never disturbs side 0's in-flight encode —
 * which matters more than it sounds, because at the worker layer abort means
 * terminate, and terminating throws away warm wasm. Hence one bridge per side.
 */

import {
  JOB_DEBOUNCE_MS,
  RESULT_CACHE_SIZE,
  SIDES,
  clonePreprocessorState,
  cloneProcessorState,
  cloneSideSettings,
  createAbortError,
  createDefaultPreprocessorState,
  createDefaultSideSettings,
  isAbortError,
  isBusy,
  isWorkerEncoderId,
  otherSide,
} from '../contracts';
import type {
  BrowserEncoderId,
  CreateWorkerBridge,
  EncoderRegistry,
  JobEngine,
  JobEngineOptions,
  JobEngineState,
  JobEvent,
  JobEventListener,
  PreprocessorState,
  ProcessorState,
  ResultCache,
  SideIndex,
  SideOutput,
  SideSettings,
  SourceImage,
  VectorSource,
  WorkerBridgeApi,
} from '../contracts';
import { LruResultCache } from './result-cache';
import {
  SourceUnavailableError,
  createDefaultEngineHooks,
  createObjectUrl,
  effectiveProcessorState,
  planWork,
  revokeObjectUrl,
  runDecode,
  runDecodeOutput,
  runEncode,
  runPreprocess,
  runProcess,
  seedResizeState,
  swapResizeDimensions,
  toError,
} from './engine';
import type { EngineHooks, MainJob, SettingsPersistence, SideJob, SideWork } from './engine';

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

export interface JobSessionOptions extends JobEngineOptions {
  /**
   * Called twice, once per side. Each side owns a worker so that aborting one
   * side never terminates the other's warm wasm.
   */
  createBridge: CreateWorkerBridge;
  /** Override any platform hook; anything omitted uses the browser default. */
  hooks?: Partial<EngineHooks>;
  /** Real encoder metadata from the codec layer; falls back to a local table. */
  registry?: EncoderRegistry;
  /** Restored settings, e.g. from {@link createSettingsPersistence}'s `load()`. */
  initialSides?: [SideSettings, SideSettings];
  initialPreprocessorState?: PreprocessorState;
  /** Written to on every settings change. Debounced by the implementation. */
  persistence?: SettingsPersistence;
  /** Convenience: subscribed before anything can happen. */
  onEvent?: JobEventListener;
}

/* -------------------------------------------------------------------------- */
/* Initial state                                                               */
/* -------------------------------------------------------------------------- */

function createSideOutput(latestSettings: SideSettings): SideOutput {
  return {
    loading: false,
    data: undefined,
    file: undefined,
    downloadUrl: undefined,
    encodedSettings: undefined,
    latestSettings,
    error: undefined,
  };
}

function createInitialState(): JobEngineState {
  return {
    source: undefined,
    loading: false,
    error: undefined,
    preprocessorState: createDefaultPreprocessorState(),
    encodedPreprocessorState: undefined,
    sides: [
      createSideOutput(createDefaultSideSettings(0)),
      createSideOutput(createDefaultSideSettings(1)),
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* The engine                                                                  */
/* -------------------------------------------------------------------------- */

export class JobSession implements JobEngine {
  /** Reactive. Treat as read-only from the UI; mutate through the methods. */
  state: JobEngineState = $state(createInitialState());

  readonly #bridges: [WorkerBridgeApi, WorkerBridgeApi];
  readonly #hooks: EngineHooks;
  readonly #cache: ResultCache;
  readonly #debounceMs: number;
  readonly #registry: EncoderRegistry | undefined;
  readonly #persistence: SettingsPersistence | undefined;
  readonly #listeners = new Set<JobEventListener>();

  /** Raw, unproxied pixels. Identity here is what the result cache keys on. */
  #sourceFile: File | undefined;
  #decoded: ImageData | undefined;
  #vector: VectorSource | undefined;
  #preprocessed: ImageData | undefined;
  #sideProcessed: [ImageData | undefined, ImageData | undefined] = [undefined, undefined];

  #mainController = new AbortController();
  #sideControllers: [AbortController, AbortController] = [
    new AbortController(),
    new AbortController(),
  ];
  /** The job currently in flight, or `undefined` when that layer is settled. */
  #activeMainJob: MainJob | undefined;
  #activeSideJobs: [SideJob | undefined, SideJob | undefined] = [undefined, undefined];
  /** Resolves with the preprocessed pixels; awaited by both sides. */
  #mainPromise: Promise<ImageData> | undefined;
  #inflight = new Set<Promise<unknown>>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(options: JobSessionOptions) {
    this.#bridges = [options.createBridge(), options.createBridge()];
    this.#hooks = { ...createDefaultEngineHooks(), ...options.hooks };
    this.#cache = new LruResultCache(options.cacheSize ?? RESULT_CACHE_SIZE);
    this.#debounceMs = options.debounceMs ?? JOB_DEBOUNCE_MS;
    this.#registry = options.registry;
    this.#persistence = options.persistence;

    if (options.initialSides) {
      for (const side of SIDES) {
        this.state.sides[side].latestSettings = cloneSideSettings(options.initialSides[side]);
      }
    }
    if (options.initialPreprocessorState) {
      this.state.preprocessorState = clonePreprocessorState(options.initialPreprocessorState);
    }
    if (options.onEvent) this.#listeners.add(options.onEvent);
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */

  setSource(file: File): void {
    if (this.#disposed) return;
    this.#sourceFile = file;
    this.state.error = undefined;
    this.state.loading = true;
    // Source loads bypass the debounce: there is nothing to coalesce, and the
    // user is staring at an empty editor until this lands.
    this.#queue(true);
  }

  updateSide(side: SideIndex, settings: SideSettings): void {
    if (this.#disposed) return;
    const output = this.state.sides[side];
    const previousEncoder = output.latestSettings.encoderId;
    const next = cloneSideSettings(settings);
    output.latestSettings = next;
    if (next.encoderId !== previousEncoder && isWorkerEncoderId(next.encoderId)) {
      // Warm the wasm while the user is still reading the options panel.
      this.#bridges[side].preload(next.encoderId);
    }
    this.#persist(side, next);
    this.#queue();
  }

  updateProcessor(side: SideIndex, processorState: ProcessorState): void {
    if (this.#disposed) return;
    const output = this.state.sides[side];
    output.latestSettings.processorState = cloneProcessorState(processorState);
    this.#persist(side, output.latestSettings);
    this.#queue();
  }

  updatePreprocessor(state: PreprocessorState): void {
    if (this.#disposed) return;
    const next = clonePreprocessorState(state);
    const orientationChanged =
      Math.abs(this.state.preprocessorState.rotate % 180) !== Math.abs(next.rotate % 180);

    this.state.preprocessorState = next;

    if (orientationChanged) {
      // The target dimensions travel with the image: 800×600 landscape becomes
      // 600×800 portrait, not a squashed 800×600.
      for (const side of SIDES) {
        swapResizeDimensions(this.state.sides[side].latestSettings.processorState.resize);
      }
    }
    this.#queue();
  }

  copySettings(from: SideIndex): void {
    if (this.#disposed) return;
    const to = otherSide(from);
    const source = this.state.sides[from];
    const target = this.state.sides[to];

    // The target's in-flight work is now moot.
    this.#abortSide(to);

    revokeObjectUrl(target.downloadUrl);
    target.latestSettings = cloneSideSettings(source.latestSettings);
    target.encodedSettings = source.encodedSettings
      ? cloneSideSettings(source.encodedSettings)
      : undefined;
    target.data = source.data;
    target.file = source.file;
    // A fresh URL, never a shared one: each side revokes its own on the next
    // encode, and a shared URL would break the other side's download link.
    target.downloadUrl = source.file ? createObjectUrl(source.file) : undefined;
    target.error = source.error;
    target.loading = false;
    this.#sideProcessed[to] = this.#sideProcessed[from];

    this.#persist(to, target.latestSettings);
    this.#queue();
  }

  abort(): void {
    if (this.#disposed) return;
    this.#clearTimer();

    this.#mainController.abort();
    this.#mainController = new AbortController();
    this.#activeMainJob = undefined;
    this.state.loading = false;

    for (const side of SIDES) {
      this.#abortSide(side);
      this.state.sides[side].loading = false;
    }
    this.#emitIdleIfSettled();
  }

  async flush(): Promise<void> {
    // Each pass can legitimately schedule another (the post-decode resize
    // reseed does exactly that), so loop until nothing is pending. The bound is
    // a guard against a pathological ping-pong, not an expected path.
    for (let guard = 0; guard < 64; guard++) {
      if (this.#disposed) return;
      if (this.#timer !== undefined) {
        this.#clearTimer();
        this.#update();
      }
      if (this.#inflight.size === 0) {
        if (this.#timer === undefined) return;
        continue;
      }
      await Promise.allSettled([...this.#inflight]);
    }
  }

  subscribe(listener: JobEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearTimer();

    this.#mainController.abort();
    for (const side of SIDES) {
      this.#sideControllers[side].abort();
      revokeObjectUrl(this.state.sides[side].downloadUrl);
      this.state.sides[side].downloadUrl = undefined;
      this.#bridges[side].terminate();
    }

    this.#cache.clear();
    this.#listeners.clear();
    this.#activeMainJob = undefined;
    this.#activeSideJobs = [undefined, undefined];
    this.#mainPromise = undefined;
    this.#decoded = undefined;
    this.#preprocessed = undefined;
    this.#sideProcessed = [undefined, undefined];
  }

  /* ------------------------------------------------------------------ */
  /* Scheduling                                                          */
  /* ------------------------------------------------------------------ */

  #queue(immediate = false): void {
    if (this.#disposed) return;
    this.#clearTimer();
    if (immediate || this.#debounceMs <= 0) {
      this.#update();
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#update();
    }, this.#debounceMs);
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Look at the whole desired state, work out the cheapest sufficient set of
   * steps, abort what it invalidates, and start it. Never partially applied:
   * this either schedules a coherent job or does nothing at all.
   */
  #update(): void {
    if (this.#disposed) return;
    const file = this.#sourceFile;
    if (!file) return;

    // "What is on screen" is the wrong baseline while work is in flight — the
    // in-flight job is what the results will describe, so diff against that.
    const current = {
      main: this.#activeMainJob ?? {
        file: this.state.source?.file,
        preprocessorState: this.state.encodedPreprocessorState,
      },
      sides: [
        this.#activeSideJobs[0] ?? this.#encodedJob(0),
        this.#activeSideJobs[1] ?? this.#encodedJob(1),
      ] as [SideJob | undefined, SideJob | undefined],
    };

    const desired = {
      main: {
        file,
        preprocessorState: clonePreprocessorState(this.state.preprocessorState),
      },
      // Snapshot out of the reactive proxy: the job must not observe later edits.
      sides: [
        { settings: cloneSideSettings(this.state.sides[0].latestSettings) },
        { settings: cloneSideSettings(this.state.sides[1].latestSettings) },
      ] as [SideJob, SideJob],
    };

    const plan = planWork(current, desired);
    if (!plan.needed) {
      this.#emitIdleIfSettled();
      return;
    }

    const mainNeeded = plan.decoding || plan.preprocessing;
    if (mainNeeded) {
      this.#mainController.abort();
      this.#mainController = new AbortController();
      this.#activeMainJob = desired.main;
      this.state.loading = true;
    }

    const sidesToRun: SideIndex[] = [];
    for (const side of SIDES) {
      const work = plan.sides[side];
      if (!work.processing && !work.encoding) continue;
      this.#sideControllers[side].abort();
      this.#sideControllers[side] = new AbortController();
      this.#activeSideJobs[side] = desired.sides[side];
      this.state.sides[side].loading = true;
      sidesToRun.push(side);
    }

    if (mainNeeded) {
      const promise = this.#runMain(this.#mainController.signal, desired.main, plan.decoding);
      this.#mainPromise = promise;
      // Tracked separately so a rejection is always handled: the sides await
      // `#mainPromise` themselves.
      this.#track(promise.then(noop, noop));
    }

    for (const side of sidesToRun) {
      const settings = desired.sides[side].settings;
      this.#emit({ type: 'side-start', side, settings });
      this.#track(
        this.#runSide(side, this.#sideControllers[side].signal, settings, plan.sides[side]),
      );
    }
  }

  #encodedJob(side: SideIndex): SideJob | undefined {
    const encoded = this.state.sides[side].encodedSettings;
    return encoded ? { settings: encoded } : undefined;
  }

  /* ------------------------------------------------------------------ */
  /* Shared work: decode + preprocess                                    */
  /* ------------------------------------------------------------------ */

  async #runMain(signal: AbortSignal, job: MainJob, decoding: boolean): Promise<ImageData> {
    try {
      assertLive(signal);

      if (decoding) {
        this.state.error = undefined;
        this.#emit({ type: 'source-loading', file: job.file });
        this.state.source = undefined;
        this.#cache.clear();
        this.#clearSideOutputs();

        const source = await runDecode(signal, job.file, this.#bridges[0], this.#hooks);
        assertLive(signal);

        this.#decoded = source.decoded;
        this.#vector = source.vector;
        this.state.source = source;
        this.#seedResize(source, job.preprocessorState);
        this.#emit({ type: 'source-decoded', source });
        // The reseed changed `latestSettings`, so re-diff. Usually a no-op —
        // two disabled resize configs compare equal — but when the previous
        // image had resizing on, this is what restarts the sides correctly.
        this.#queue();
      }

      const decoded = this.#decoded;
      if (!decoded) throw new SourceUnavailableError('No decoded source image');

      const preprocessed = await runPreprocess(
        signal,
        decoded,
        job.preprocessorState,
        this.#bridges[0],
        this.#hooks,
      );
      assertLive(signal);

      this.#preprocessed = preprocessed;
      this.state.encodedPreprocessorState = clonePreprocessorState(job.preprocessorState);
      // Intermediate render: show the preprocessed pixels immediately rather
      // than a blank canvas while the encoders run.
      this.#clearSideOutputs(preprocessed);
      this.state.loading = false;
      if (this.#activeMainJob === job) this.#activeMainJob = undefined;

      return preprocessed;
    } catch (error) {
      if (isAbortError(error)) throw error;

      // A newer main job has taken over; it owns the state now.
      if (this.#mainController.signal !== signal) throw new SourceUnavailableError();

      const normalised = toError(error);
      this.state.loading = false;
      this.state.error = normalised.message;
      this.state.source = undefined;
      this.#decoded = undefined;
      this.#preprocessed = undefined;
      if (this.#activeMainJob === job) this.#activeMainJob = undefined;
      this.#emit({ type: 'source-error', error: normalised });
      for (const side of SIDES) this.state.sides[side].loading = false;
      this.#emitIdleIfSettled();

      // Sides awaiting this recognise the type and stay quiet: one failure,
      // reported once, on the thing that actually failed.
      throw new SourceUnavailableError(normalised.message, { cause: normalised });
    }
  }

  /** The preprocessed pixels both sides depend on, once they exist. */
  #mainReady(): Promise<ImageData> {
    if (this.#mainPromise) return this.#mainPromise;
    if (this.#preprocessed) return Promise.resolve(this.#preprocessed);
    return Promise.reject(new SourceUnavailableError());
  }

  #seedResize(source: SourceImage, preprocessorState: PreprocessorState): void {
    const rotated = preprocessorState.rotate % 180 !== 0;
    const width = rotated ? source.decoded.height : source.decoded.width;
    const height = rotated ? source.decoded.width : source.decoded.height;
    for (const side of SIDES) {
      // Left disabled on purpose: a silently-applied resize on a new image is
      // how you end up shipping a 200px hero.
      seedResizeState(this.state.sides[side].latestSettings.processorState.resize, width, height);
    }
  }

  #clearSideOutputs(data?: ImageData): void {
    for (const side of SIDES) {
      const output = this.state.sides[side];
      revokeObjectUrl(output.downloadUrl);
      output.downloadUrl = undefined;
      output.file = undefined;
      output.data = data;
      output.encodedSettings = undefined;
      output.error = undefined;
      this.#sideProcessed[side] = undefined;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Per-side work: process + encode                                     */
  /* ------------------------------------------------------------------ */

  async #runSide(
    side: SideIndex,
    signal: AbortSignal,
    settings: SideSettings,
    work: SideWork,
  ): Promise<void> {
    try {
      assertLive(signal);
      const preprocessed = await this.#mainReady();
      assertLive(signal);

      const source = this.state.source;
      if (!source) throw new SourceUnavailableError();

      const processorState = effectiveProcessorState(settings);
      let file: File;
      let data: ImageData;
      let processed: ImageData;
      // Set only if the wasm worker failed and a canvas encoder stood in.
      let usedFallback: BrowserEncoderId | undefined;

      if (settings.encoderId === 'identity') {
        // Pass-through: the original bytes, and the preprocessed pixels as the
        // preview. No encoder, no cache entry, nothing to re-decode.
        file = source.file;
        data = preprocessed;
        processed = preprocessed;
      } else {
        const hit = this.#cache.match(
          preprocessed,
          processorState,
          settings.encoderId,
          settings.encoderOptions,
        );

        if (hit) {
          ({ file, data, processed } = hit);
          // A cached browser-fallback result must stay labelled as one, or the
          // UI would present it as the selected wasm codec's output.
          usedFallback = hit.encoderFallback;
        } else {
          const previous = this.#sideProcessed[side];
          if (work.processing || !previous) {
            processed = await runProcess(
              signal,
              preprocessed,
              processorState,
              this.#bridges[side],
              this.#hooks,
              this.#vector,
            );
            assertLive(signal);
            this.#sideProcessed[side] = processed;
            // Intermediate render again: resized pixels beat stale ones while
            // the encoder chews.
            this.state.sides[side].data = processed;
          } else {
            processed = previous;
          }

          file = await runEncode(
            signal,
            processed,
            settings,
            source.file,
            this.#bridges[side],
            this.#hooks,
            this.#registry,
            (id) => {
              usedFallback = id;
            },
          );
          assertLive(signal);

          // Decode the result rather than reusing `processed`: the whole point
          // of the compare view is seeing what the codec actually did.
          data = await runDecodeOutput(signal, file, this.#bridges[side], this.#hooks);
          assertLive(signal);

          this.#cache.add({
            preprocessed,
            processorState,
            encoderId: settings.encoderId,
            encoderOptions: settings.encoderOptions,
            processed,
            data,
            file,
            encoderFallback: usedFallback,
          });
        }
      }

      const output = this.state.sides[side];
      revokeObjectUrl(output.downloadUrl);
      output.data = data;
      output.file = file;
      output.downloadUrl = createObjectUrl(file);
      output.encodedSettings = cloneSideSettings(settings);
      output.error = undefined;
      output.encoderFallback = usedFallback;
      output.loading = false;
      this.#sideProcessed[side] = processed;
      if (this.#activeSideJobs[side]?.settings === settings) {
        this.#activeSideJobs[side] = undefined;
      }

      this.#emit({ type: 'side-encoded', side, file, settings });
      this.#emitIdleIfSettled();
    } catch (error) {
      // Someone else owns this side now; leave their state alone.
      if (this.#sideControllers[side].signal !== signal) return;
      if (isAbortError(error)) return;

      if (this.#activeSideJobs[side]?.settings === settings) {
        this.#activeSideJobs[side] = undefined;
      }
      this.state.sides[side].loading = false;

      // The source failed; it has already reported itself.
      if (error instanceof SourceUnavailableError) {
        this.#emitIdleIfSettled();
        return;
      }

      const normalised = toError(error);
      this.state.sides[side].error = normalised.message;
      this.#emit({ type: 'side-error', side, error: normalised });
      this.#emitIdleIfSettled();
    }
  }

  #abortSide(side: SideIndex): void {
    this.#sideControllers[side].abort();
    this.#sideControllers[side] = new AbortController();
    this.#activeSideJobs[side] = undefined;
  }

  /* ------------------------------------------------------------------ */
  /* Plumbing                                                            */
  /* ------------------------------------------------------------------ */

  #track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => {
      this.#inflight.delete(tracked);
    });
    this.#inflight.add(tracked);
    return tracked;
  }

  #persist(side: SideIndex, settings: SideSettings): void {
    // Always a plain clone: a `$state` proxy is not structured-cloneable and
    // IndexedDB would reject it.
    this.#persistence?.save(side, cloneSideSettings(settings));
  }

  #emit(event: JobEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[squish] job event listener threw', error);
      }
    }
  }

  #emitIdleIfSettled(): void {
    if (this.#timer !== undefined) return;
    if (isBusy(this.state)) return;
    this.#emit({ type: 'idle' });
  }
}

/** Throw the canonical `AbortError` if this job has been superseded. */
function assertLive(signal: AbortSignal): void {
  if (signal.aborted) throw createAbortError();
}

function noop(): void {
  /* deliberately empty */
}

/** Factory form, for code that would rather not `new`. */
export function createJobSession(options: JobSessionOptions): JobSession {
  return new JobSession(options);
}
