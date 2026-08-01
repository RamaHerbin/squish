<script lang="ts">
  /**
   * The editor screen — comp "02 Editor" / "02b Encoder + advanced", mobile
   * "06b".
   *
   * Three bands under the shell's 56px top bar:
   *
   *   ┌──────────────────────────────────────────────┐
   *   │ RevealCompare  (flex: 1, the image bed)       │
   *   ├──────────────────────────────────────────────┤
   *   │ AdvancedDrawer (only while `Advanced` is on)  │
   *   │ Toolbar        (108px)                        │  ← both from EditorControls
   *   └──────────────────────────────────────────────┘
   *
   * Owned by integration rather than by any one feature directory: it is the
   * only place that knows about `state`, `codecs`, `compare`, `options`,
   * `metrics`, `edit` and `settings` at once. Everything it renders belongs to
   * somebody else; what lives here is the wiring.
   *
   * ## One config, one reveal
   * Side 0 is pinned to `identity` by the shell when the session is created, so
   * it always holds the preprocessed original. Side 1 carries the user's
   * settings. The user therefore edits *one* configuration and the divider
   * reveals its output over the original — no second settings column.
   *
   * ## Two clocks
   * Controls read `latestSettings` (what the user asked for); captions and
   * metrics read `encodedSettings` (what produced the pixels on screen). The
   * gap between them is the loading affordance.
   *
   * ## Crop space
   * `PreprocessorState.crop` is defined in *rotated source* pixels, before any
   * crop — so while the crop tool is open we hand `RevealCompare` the rotated,
   * uncropped pixels and matching `cropImageWidth/Height`, and its own
   * letterbox maths does the viewport ⇄ image mapping.
   */
  import { onDestroy } from 'svelte';

  import type {
    CreateWorkerBridge,
    CropRect,
    EncoderId,
    EncoderRegistry,
    ImageMimeType,
    JobEngine,
    MetricsResult,
    RotateAngle,
    SideSettings,
    WorkerBridgeApi,
  } from './contracts';
  import {
    EXTENSION_BY_MIME,
    WORKER_ENCODER_IDS,
    cloneSideSettings,
    savingsPct,
  } from './contracts';

  import { getCapabilities, hdrLabel, toSrgb } from './codecs';
  import {
    createDefaultEngineHooks,
    effectiveProcessorState,
    runDecodeOutput,
    runEncode,
    runProcess,
  } from './state';
  import type { EngineHooks } from './state';

  import { RevealCompare } from './compare';
  import { EditorControls, formatBytes, formatSavings, primaryKnob } from './options';
  import { AutoSuggestController, getSharedMetricsClient } from './metrics';
  import { createEditState } from './edit/edit.svelte';
  import { rotate as rotateImage } from './edit/transform';
  import { canShareFiles, messageOf, saveBlob, shareFiles } from './platform';
  import { appSettings } from './settings/settings.svelte';

  /** How long the pixels have to sit still before SSIM is worth paying for. */
  const METRICS_DEBOUNCE_MS = 180;

  /**
   * The codec seam, injected by the shell so this component and the shell's
   * sessions encode through exactly the same hooks. Auto-suggest needs a
   * *scratch* pipeline of its own: probing quality must not disturb side 1.
   *
   * Structural, and deliberately not exported — the shell hands over a plain
   * object literal and TypeScript checks the shape at the call site.
   */
  interface EditorPipeline {
    createBridge: CreateWorkerBridge;
    hooks: Partial<EngineHooks>;
    registry: EncoderRegistry;
  }

  interface Props {
    /** The active tab's engine. Created and disposed by the app shell. */
    session: JobEngine;
    /** Injected codec hooks; see {@link EditorPipeline}. */
    pipeline: EditorPipeline;
    /** Called the first time the user changes anything — drives the tab dot. */
    ondirty?: () => void;
  }

  let { session, pipeline, ondirty }: Props = $props();

  const st = $derived(session.state);

  /* ------------------------------------------------------------------ */
  /* Encoder availability                                                */
  /* ------------------------------------------------------------------ */

  let supportedEncoderIds = $state<ReadonlySet<EncoderId> | undefined>(undefined);

  $effect(() => {
    let cancelled = false;
    void getCapabilities().then((report) => {
      if (cancelled) return;
      const ids = new Set<EncoderId>(['identity']);
      // wasm codecs are lazily instantiated; presence of the namespace is the
      // only cheap up-front signal, and the per-encoder featureTest still runs
      // before an actual encode.
      if (typeof WebAssembly !== 'undefined') {
        for (const id of WORKER_ENCODER_IDS) ids.add(id);
      }
      if (report.encodesNatively['image/png']) ids.add('browser-png');
      if (report.encodesNatively['image/jpeg']) ids.add('browser-jpeg');
      if (report.encodesNatively['image/webp']) ids.add('browser-webp');
      supportedEncoderIds = ids;
    });
    return () => {
      cancelled = true;
    };
  });

  /* ------------------------------------------------------------------ */
  /* Derived geometry                                                    */
  /* ------------------------------------------------------------------ */

  /** Source dimensions after rotation, before crop — the space `CropRect` uses. */
  const rotatedSize = $derived.by(() => {
    const decoded = st.source?.decoded;
    if (!decoded) return { width: 1, height: 1 };
    const swapped = st.preprocessorState.rotate % 180 !== 0;
    return {
      width: swapped ? decoded.height : decoded.width,
      height: swapped ? decoded.width : decoded.height,
    };
  });

  /** Dimensions the per-side resize applies to: rotated *and* cropped. */
  const processedSize = $derived.by(() => {
    const crop = st.preprocessorState.crop;
    if (crop) {
      return {
        width: Math.max(1, Math.round(crop.width)),
        height: Math.max(1, Math.round(crop.height)),
      };
    }
    return rotatedSize;
  });

  /**
   * The preprocessed pixels, as far as they can be recovered from the public
   * engine state: side 0 is pinned to `identity`, and the engine renders those
   * verbatim. Used as the reveal's size reference so a resized output
   * letterboxes instead of dragging the original half out of alignment.
   */
  const referencePixels = $derived(st.sides[0].data ?? st.sides[1].data);

  /** What the encode actually produced, in output pixels. */
  const outputSize = $derived.by(() => {
    const data = st.sides[1].data;
    if (data && st.sides[1].encodedSettings) return { width: data.width, height: data.height };
    return processedSize;
  });

  /* ------------------------------------------------------------------ */
  /* Labels                                                              */
  /* ------------------------------------------------------------------ */

  function encoderLabelFor(id: EncoderId | undefined): string {
    if (!id) return '';
    return id === 'identity' ? 'Original' : pipeline.registry[id].label;
  }

  /** `JPEG`, `PNG`, … from the source file's type, falling back to its name. */
  const sourceFormatLabel = $derived.by(() => {
    const file = st.source?.file;
    if (!file) return '';
    const type = file.type as ImageMimeType;
    const known = Object.prototype.hasOwnProperty.call(EXTENSION_BY_MIME, type)
      ? EXTENSION_BY_MIME[type]
      : undefined;
    const extension = known ?? file.name.split('.').pop() ?? '';
    return extension.toUpperCase();
  });

  const encodedSettings = $derived(st.sides[1].encodedSettings);
  const outputEncoderLabel = $derived(encoderLabelFor(encodedSettings?.encoderId));

  /** `AVIF · q52 · 4032 × 3024` — describes the pixels, never the pending edit. */
  const outputMeta = $derived.by(() => {
    if (!encodedSettings) return st.sides[1].loading ? 'Encoding…' : '';
    const knob = primaryKnob(encodedSettings);
    // OxiPNG's dial is effort, not quality; saying `q2` would be a lie.
    const dial =
      knob.kind === 'quality' ? `q${knob.valueText}` : knob.kind === 'effort' ? `e${knob.valueText}` : '';
    // The wasm codec failed and a canvas encoder stood in — flag the degraded output.
    const fallback = st.sides[1].encoderFallback ? 'browser encoder' : '';
    return [outputEncoderLabel, dial, `${outputSize.width} × ${outputSize.height}`, fallback]
      .filter(Boolean)
      .join(' · ');
  });

  const originalBytes = $derived(st.source?.file.size ?? 0);
  const outputBytes = $derived(st.sides[1].file?.size);

  /** `−87%`, with the comp's typographic minus. `+4%` when the encode grew. */
  const outputDelta = $derived(
    outputBytes === undefined || originalBytes <= 0 ? '' : formatSavings(originalBytes, outputBytes),
  );

  /** Yellow is the comp's "you saved something"; a bigger file is a red flag. */
  const outputDeltaTone = $derived(
    outputBytes !== undefined && originalBytes > 0 && savingsPct(originalBytes, outputBytes) < 0
      ? 'red'
      : 'yellow',
  );

  /* ------------------------------------------------------------------ */
  /* Settings writes                                                     */
  /* ------------------------------------------------------------------ */

  function applySettings(next: SideSettings): void {
    session.updateSide(1, next);
    ondirty?.();
  }

  /* ------------------------------------------------------------------ */
  /* Preprocessing: rotate + crop                                        */
  /* ------------------------------------------------------------------ */

  const editState = createEditState();
  const cropping = $derived(editState.mode === 'cropping');

  /**
   * Rotation only emits the next angle — `JobEngine.updatePreprocessor` owns
   * swapping each side's resize width/height across a 90°/270° boundary, and
   * duplicating that here would swap it twice. A crop rectangle lives in
   * rotated-source space, so it has to travel with the rotation or it would
   * suddenly describe a different region (and, past 90°, fall out of bounds).
   */
  function handleRotate(): void {
    const current = st.preprocessorState;
    const next = (((current.rotate + 90) % 360) + 360) % 360;
    if (!current.crop) {
      session.updatePreprocessor({ rotate: next as RotateAngle });
      ondirty?.();
      return;
    }
    const rect = current.crop;
    session.updatePreprocessor({
      rotate: next as RotateAngle,
      // +90° only: `x' = H − y − h`, `y' = x`, with the axes swapped.
      crop: {
        x: rotatedSize.height - rect.y - rect.height,
        y: rect.x,
        width: rect.height,
        height: rect.width,
      },
    });
    ondirty?.();
  }

  function applyCrop(rect: CropRect): void {
    session.updatePreprocessor({ rotate: st.preprocessorState.rotate, crop: rect });
    ondirty?.();
  }

  /**
   * Rotated-but-uncropped pixels. Computed only while the crop tool is open —
   * the preprocessed pixels are already cropped, so they cannot describe the
   * space a new `CropRect` lives in.
   */
  const cropImage = $derived.by(() => {
    if (!cropping) return undefined;
    const decoded = st.source?.decoded;
    if (!decoded) return undefined;
    return st.preprocessorState.rotate === 0
      ? decoded
      : rotateImage(decoded, st.preprocessorState.rotate);
  });

  /* ------------------------------------------------------------------ */
  /* Metrics                                                             */
  /* ------------------------------------------------------------------ */

  const metricsClient = getSharedMetricsClient();
  let metrics = $state<MetricsResult | null>(null);

  $effect(() => {
    const original = st.sides[0].data;
    const output = st.sides[1].data;
    const settled = st.sides[1].encodedSettings;

    if (!original || !output || !settled) {
      metrics = null;
      return;
    }
    // Keep the last reading on screen while the next encode runs; blanking it
    // on every slider nudge is noise, not honesty.
    if (st.sides[1].loading || st.loading) return;
    // `identity` hands the same pixels back; the worker would only confirm it.
    if (original === output) {
      metrics = { ssim: 1, ms: 0 };
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      // The output is sRGB; a wide-gamut original must be gamut-mapped to the
      // same space or SSIM compares different coordinates, not visual colours.
      void metricsClient
        .measure(toSrgb(original), output, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          metrics = { ssim: result.ssim, ms: result.ms };
        })
        .catch(() => {
          /* AbortError only — a superseded measurement has nothing to say. */
        });
    }, METRICS_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });

  const metricsNote = $derived.by(() => {
    if (metrics && metrics.ssim === null) return 'Not comparable at this size';
    return undefined;
  });

  /* ------------------------------------------------------------------ */
  /* Auto-suggest                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * A scratch encode pipeline. The search runs several encodes per suggestion
   * and must not touch side 1 — otherwise the editor and the search fight over
   * the same settings and the preview flickers through every probe.
   */
  const probeHooks = $derived<EngineHooks>({
    ...createDefaultEngineHooks(),
    ...pipeline.hooks,
  });
  let probeBridge: WorkerBridgeApi | undefined;
  /** Reference pixels the last probe was measured against (post-resize). */
  let probeReference: ImageData | undefined;

  function bridge(): WorkerBridgeApi {
    probeBridge ??= pipeline.createBridge();
    return probeBridge;
  }

  const auto = new AutoSuggestController({
    encodeAt: async (quality, signal) => {
      const base = st.sides[0].data;
      const file = st.source?.file;
      if (!base || !file) throw new Error('No image to test yet');

      // Plain clone: `latestSettings` is a `$state` proxy and a proxy cannot be
      // structured-cloned into the codec worker.
      const settings = cloneSideSettings(primaryKnob(st.sides[1].latestSettings).apply(quality));
      const scope = signal ?? new AbortController().signal;

      const processed = await runProcess(
        scope,
        base,
        effectiveProcessorState(settings),
        bridge(),
        probeHooks,
      );
      const encoded = await runEncode(
        scope,
        processed,
        settings,
        file,
        bridge(),
        probeHooks,
        pipeline.registry,
        undefined,
        // No browser fallback in a probe: a silent codec swap would measure the
        // wrong encoder and poison the auto-suggest binary search.
        false,
      );
      const data = await runDecodeOutput(scope, encoded, bridge(), probeHooks);
      probeReference = processed;
      return { size: encoded.size, data };
    },
    // Measured against the *processed* pixels, so an active resize compares
    // like with like instead of resolving to "dimensions differ".
    measure: (data, _quality, signal) => {
      const reference = probeReference ?? st.sides[0].data;
      if (!reference) return Promise.resolve(null);
      // `data` is the sRGB decode of the probe output; match the reference to it.
      return metricsClient.measure(toSrgb(reference), data, signal);
    },
    encoderLabel: () => encoderLabelFor(st.sides[1].latestSettings.encoderId),
    originalBytes: () => st.source?.file.size ?? 0,
    onApply: (suggestion) => {
      applySettings(cloneSideSettings(primaryKnob(st.sides[1].latestSettings).apply(suggestion.quality)));
    },
  });

  /** Only encoders with a real quality dial can be searched. */
  const autoSearchable = $derived(primaryKnob(st.sides[1].latestSettings).kind === 'quality');

  /**
   * One suggestion per (file, encoder, probe-input state). Plain, not
   * `$state`: it guards the effect below and must not retrigger it.
   */
  let autoKey: string | undefined;

  $effect(() => {
    const file = st.source?.file;
    const encoderId = st.sides[1].latestSettings.encoderId;
    const ready = st.sides[0].data !== undefined && !st.loading;

    if (!appSettings.current.autoSuggest || !autoSearchable || !ready || !file) return;

    // Everything that changes the pixels the probe encodes must be in the
    // key, or a stale suggestion survives a crop/resize change.
    const key = [
      file.name,
      file.size,
      file.lastModified,
      encoderId,
      st.preprocessorState.rotate,
      JSON.stringify(st.preprocessorState.crop ?? null),
      JSON.stringify(st.sides[1].latestSettings.processorState.resize),
    ].join(':');
    if (key === autoKey) return;
    autoKey = key;
    auto.reset();
    void auto.run();
  });

  function handleAuto(): void {
    if (auto.state === 'running') auto.cancel();
    else if (auto.state === 'error') void auto.run();
    else auto.apply();
  }

  /* ------------------------------------------------------------------ */
  /* Download and share                                                  */
  /* ------------------------------------------------------------------ */

  const downloadUrl = $derived(st.sides[1].downloadUrl);

  /**
   * The pill is enabled off `downloadUrl` (the engine's object URL, which is
   * exactly "an encode has landed"), but the bytes come from the `File` itself
   * so the platform layer can hand them to a native save panel. On the web
   * `saveBlob` is the same throwaway-anchor download as before, and it runs
   * synchronously — no await before the click, so the gesture is preserved.
   */
  let egressError = $state<string | undefined>(undefined);

  function download(): void {
    const file = st.sides[1].file;
    if (!file) return;
    egressError = undefined;
    // No await before the anchor click on the web path, so the user gesture is
    // preserved; the catch only ever fires on the native dialog/fs path.
    saveBlob(file.name, file).catch((error) => {
      egressError = `Could not save: ${messageOf(error)}`;
    });
  }

  /**
   * The encoded output is already a `File` with the right name and MIME type,
   * so the browser is asked about the real thing rather than a stand-in. The
   * answer moves with the encoder: JPEG XL is on no user agent's share
   * allowlist, so the button disappears when the editor switches to it.
   */
  const outputFile = $derived(st.sides[1].file);
  const shareable = $derived(outputFile !== undefined && canShareFiles([outputFile]));

  function share(): void {
    const file = st.sides[1].file;
    if (!file) return;
    egressError = undefined;
    // Nothing awaited before `navigator.share`, or Safari has already spent the
    // gesture by the time the sheet is asked for.
    shareFiles([file]).catch((error) => {
      egressError = `Could not share: ${messageOf(error)}`;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Teardown                                                            */
  /* ------------------------------------------------------------------ */

  onDestroy(() => {
    auto.dispose();
    probeBridge?.terminate();
    probeBridge = undefined;
    probeReference = undefined;
  });
</script>

<div class="editor">
  {#if st.error}
    <p class="editor-error" role="alert">{st.error}</p>
  {/if}
  {#if egressError}
    <p class="editor-error" role="alert">{egressError}</p>
  {/if}

  <div class="editor-stage">
    <RevealCompare
      original={cropping ? cropImage : st.sides[0].data}
      output={cropping ? undefined : st.sides[1].data}
      source={cropping ? cropImage : referencePixels}
      sourceKey={st.source?.file}
      originalSize={st.source ? formatBytes(originalBytes) : ''}
      originalMeta={st.source
        ? [
            sourceFormatLabel,
            ...(st.source.hdr ? [`${hdrLabel(st.source.hdr)} → SDR`] : []),
            ...(st.source.decoded.colorSpace === 'display-p3' ? ['P3'] : []),
            `${processedSize.width} × ${processedSize.height}`,
          ].join(' · ')
        : ''}
      outputSize={outputBytes === undefined ? '' : formatBytes(outputBytes)}
      outputDelta={outputDelta}
      outputDeltaTone={outputDeltaTone}
      outputMeta={outputMeta}
      placeholder={st.loading ? 'Decoding…' : 'No image open'}
      autoOpen={auto.visible}
      autoMessage={auto.message ?? ''}
      autoActionLabel={auto.actionLabel ?? ''}
      onauto={handleAuto}
      onrotate={handleRotate}
      {editState}
      cropImageWidth={rotatedSize.width}
      cropImageHeight={rotatedSize.height}
      crop={st.preprocessorState.crop}
      onCropApply={applyCrop}
    />
  </div>

  <EditorControls
    registry={pipeline.registry}
    {supportedEncoderIds}
    settings={st.sides[1].latestSettings}
    onchange={applySettings}
    fileName={st.source?.file.name ?? ''}
    {originalBytes}
    sourceWidth={processedSize.width}
    sourceHeight={processedSize.height}
    {outputBytes}
    encoding={st.sides[1].loading}
    error={st.sides[1].error}
    {metrics}
    {metricsNote}
    onDownload={download}
    downloadDisabled={downloadUrl === undefined}
    onShare={shareable ? share : undefined}
  />
</div>

<style>
  .editor {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    background: var(--paper);
  }

  /**
   * `RevealCompare` is `width/height: 100%` and brings its own `--image-bed`
   * background, so it needs a parent with a definite box and nothing else.
   */
  .editor-stage {
    position: relative;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }

  .editor-error {
    flex: none;
    margin: 0;
    padding: var(--space-3) var(--space-6);
    border-bottom: var(--border-hairline);
    background: var(--surface);
    color: var(--accent-red);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono-tight);
  }
</style>
