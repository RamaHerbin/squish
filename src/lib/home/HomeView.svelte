<script lang="ts">
  /**
   * "01 Home" — the landing screen shown while no tab is open.
   *
   * The 64px "PINCH" top bar in the comp is the shell's, not this
   * component's: `HomeView` starts right under it and owns everything from
   * the hero grid down through the yellow footer ticker.
   *
   * Behaviour is ported from the legacy `shell/IntroView.svelte` (whole-page
   * drag target, paste-from-clipboard, file picker, bundled demo images) —
   * only the visuals are new. The whole page is the drop target for as long
   * as this component is mounted, matching the parent's `{#if view ===
   * 'home'}` gating.
   */
  import { onMount } from 'svelte';

  import { accentFill, Chip, PillButton, Ticker, type AccentName } from '$lib/ui';
  import {
    EXTENSION_BY_MIME,
    FILE_PICKER_ACCEPT,
    mimeTypeFromFilename,
    type ImageMimeType,
  } from '$lib/contracts';

  /** Real MIME per sample; the response blob's type as fallback, never SVG by default. */
  function mimeTypeForSample(name: string, blob: Blob): string {
    return mimeTypeFromFilename(name) || blob.type || 'application/octet-stream';
  }
  import { formatBytes } from '$lib/batch/format';

  /** Below this width the layout stacks per comp section "06a Mobile home". */
  const COMPACT_BREAKPOINT = 700;

  interface DemoSample {
    readonly id: string;
    readonly url: string;
    readonly name: string;
    readonly label: string;
    readonly width: number;
    readonly height: number;
    readonly initial: string;
    readonly accent: AccentName;
    readonly format: string;
  }

  /**
   * Bundled sample images (`public/demo/`), generated deterministically by
   * `scripts/generate-assets.mjs` — synthetic, so no third-party rights ride
   * along. Sizes are fetched at runtime, never hard-coded.
   */
  const DEMO_SAMPLES: readonly DemoSample[] = [
    {
      id: 'sunset',
      url: '/demo/demo-sunset.jpg',
      name: 'demo-sunset.jpg',
      label: 'Sunset gradient photo',
      width: 1600,
      height: 1200,
      initial: 'S',
      accent: 'blue',
      format: 'JPEG',
    },
    {
      id: 'poster',
      url: '/demo/demo-poster.png',
      name: 'demo-poster.png',
      label: 'Geometric poster',
      width: 1200,
      height: 900,
      initial: 'P',
      accent: 'red',
      format: 'PNG',
    },
    {
      id: 'orbit',
      url: '/demo/demo-orbit.svg',
      name: 'demo-orbit.svg',
      label: 'Abstract orbit',
      width: 640,
      height: 480,
      initial: 'O',
      accent: 'green',
      format: 'SVG',
    },
  ];

  const SAMPLE_SLOT_COUNT = 3;

  interface Props {
    /** Every image file gathered from a drop, paste, or the file picker. */
    onfiles: (files: File[]) => void;
    /** A bundled sample, already fetched into a real `File`. */
    onsample: (file: File) => void;
  }

  let { onfiles, onsample }: Props = $props();

  // Desktop-first default (matches the 1440×900 comps) — corrected the instant
  // `bind:innerWidth` reports the real value, same pattern as EditorView.
  let windowWidth = $state(1280);
  let fileInput = $state<HTMLInputElement | undefined>();
  let dragDepth = $state(0);
  let notice = $state<string | undefined>(undefined);
  let loadingSample = $state<string | undefined>(undefined);
  let sampleMeta = $state<Record<string, { bytes: number; blob: Blob }>>({});

  const isDragging = $derived(dragDepth > 0);
  const isCompact = $derived(windowWidth <= COMPACT_BREAKPOINT);

  const sampleSlots = $derived<readonly (DemoSample | null)[]>(
    isCompact
      ? DEMO_SAMPLES
      : [
          ...DEMO_SAMPLES,
          ...Array.from({ length: Math.max(0, SAMPLE_SLOT_COUNT - DEMO_SAMPLES.length) }, () => null),
        ],
  );

  onMount(() => {
    let cancelled = false;
    for (const demo of DEMO_SAMPLES) {
      void (async () => {
        try {
          const response = await fetch(demo.url);
          if (!response.ok) throw new Error(String(response.status));
          const blob = await response.blob();
          if (cancelled) return;
          sampleMeta = { ...sampleMeta, [demo.id]: { bytes: blob.size, blob } };
        } catch {
          // The card still works without a size caption — clicking it
          // re-fetches in `useSample`.
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  });

  function sampleSizeLabel(demo: DemoSample): string {
    const meta = sampleMeta[demo.id];
    return meta ? formatBytes(meta.bytes) : '···';
  }

  function filesFromTransfer(dt: DataTransfer | null): File[] {
    if (!dt) return [];
    return Array.from(dt.files ?? []);
  }

  function openPicker(): void {
    fileInput?.click();
  }

  function onChooseClick(event: MouseEvent): void {
    event.stopPropagation();
    openPicker();
  }

  function onPickerChange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length > 0) {
      notice = undefined;
      onfiles(files);
    }
  }

  function onDropzoneKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openPicker();
  }

  function onDragEnter(event: DragEvent): void {
    event.preventDefault();
    dragDepth += 1;
  }

  function onDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave(event: DragEvent): void {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault();
    dragDepth = 0;
    const files = filesFromTransfer(event.dataTransfer);
    if (files.length > 0) {
      notice = undefined;
      onfiles(files);
    } else {
      notice = "That didn't look like a file.";
    }
  }

  function onWindowPaste(event: ClipboardEvent): void {
    const files = filesFromTransfer(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    notice = undefined;
    onfiles(files);
  }

  function extensionFor(mimeType: string): string {
    return EXTENSION_BY_MIME[mimeType as ImageMimeType] ?? 'png';
  }

  /** The explicit "Paste" button — `onWindowPaste` (⌘V) is the primary path. */
  async function pasteFromClipboard(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (typeof navigator === 'undefined' || !navigator.clipboard?.read) {
      notice = 'Press ⌘V / Ctrl+V to paste instead.';
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      let index = 0;
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith('image/'));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        index += 1;
        files.push(new File([blob], `pasted-${index}.${extensionFor(imageType)}`, { type: imageType }));
      }
      if (files.length > 0) {
        notice = undefined;
        onfiles(files);
      } else {
        notice = 'Clipboard has no image.';
      }
    } catch {
      notice = 'Clipboard access blocked — press ⌘V instead.';
    }
  }

  async function useSample(demo: DemoSample): Promise<void> {
    if (loadingSample !== undefined) return;
    loadingSample = demo.id;
    notice = undefined;
    try {
      let blob = sampleMeta[demo.id]?.blob;
      if (!blob) {
        const response = await fetch(demo.url);
        if (!response.ok) throw new Error(String(response.status));
        blob = await response.blob();
      }
      onsample(new File([blob], demo.name, { type: mimeTypeForSample(demo.name, blob) }));
    } catch {
      notice = "Couldn't load that sample.";
    } finally {
      loadingSample = undefined;
    }
  }
</script>

<svelte:window
  bind:innerWidth={windowWidth}
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  onpaste={onWindowPaste}
/>

<div class="home">
  <div class="hero">
    <div class="hero-copy">
      <h1 class="hero-title">
        {#if isCompact}
          Compress<br />images here,<br />not there.
        {:else}
          Compress<br />images in<br />your browser.
        {/if}
      </h1>

      {#if !isCompact}
        <p class="hero-subtitle">
          Nothing is uploaded. Every codec runs locally, and you see exactly what you are trading
          away before you download.
        </p>

        <div class="specs">
          <div class="spec-row">
            <span class="spec-label">Encoders</span>
            <Chip tone="blue">9 · AVIF · WEBP · JPEG XL…</Chip>
          </div>
          <div class="spec-row">
            <span class="spec-label">Metrics</span>
            <Chip tone="purple">SSIM</Chip>
          </div>
          <div class="spec-row">
            <span class="spec-label">Batch</span>
            <Chip tone="green">Up to 5,000 files</Chip>
          </div>
        </div>
      {/if}
    </div>

    <div class="hero-drop">
      <!-- role/tabindex are set together when compact; the compiler can't see the correlation. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="dropzone"
        class:is-dragging={isDragging}
        role={isCompact ? 'button' : undefined}
        tabindex={isCompact ? 0 : undefined}
        aria-label={isCompact ? 'Choose images to compress' : undefined}
        onclick={isCompact ? openPicker : undefined}
        onkeydown={isCompact ? onDropzoneKeydown : undefined}
      >
        <div class="dropzone-inset" aria-hidden="true"></div>
        <div class="dropzone-content">
          <div class="drop-icon" aria-hidden="true">+</div>
          <div class="drop-title">
            {isCompact ? 'Choose images' : isDragging ? 'Drop it' : 'Drop images here'}
          </div>
          <div class="drop-sub">
            {isCompact ? 'Camera roll · files · paste' : 'or paste from clipboard'}
          </div>

          {#if !isCompact}
            <div class="drop-actions">
              <PillButton
                variant="solid"
                size={38}
                font="body"
                flair="var(--cream)"
                onclick={onChooseClick}
              >
                Choose files
              </PillButton>
              <PillButton
                variant="outline"
                size={38}
                font="body"
                flair="ink"
                onclick={pasteFromClipboard}
              >
                Paste
                {#snippet trailing()}<span aria-hidden="true">↗</span>{/snippet}
              </PillButton>
            </div>
          {/if}

          {#if notice}
            <p class="notice" role="alert">{notice}</p>
          {/if}
        </div>

        {#if !isCompact}
          <div class="corner corner-left" aria-hidden="true">JPEG · PNG · WEBP · AVIF · HEIC · SVG · GIF</div>
          <div class="corner corner-right" aria-hidden="true">MAX 50 MB / FILE</div>
        {/if}
      </div>

      <input
        bind:this={fileInput}
        type="file"
        accept={FILE_PICKER_ACCEPT}
        multiple
        class="sr-only"
        tabindex="-1"
        onchange={onPickerChange}
      />

      <div class="samples">
        <div class="samples-label">{isCompact ? 'Samples' : 'Or start from a sample'}</div>
        <div class="samples-grid">
          {#each sampleSlots as demo, i (demo ? demo.id : `ghost-${i}`)}
            {#if demo}
              {#if isCompact}
                <button
                  type="button"
                  class="sample-card sample-card--compact"
                  disabled={loadingSample !== undefined}
                  aria-label={`Use sample: ${demo.label}`}
                  onclick={() => void useSample(demo)}
                >
                  {#if loadingSample === demo.id}
                    <span class="sample-loading">Loading…</span>
                  {/if}
                </button>
              {:else}
                <button
                  type="button"
                  class="sample-card"
                  disabled={loadingSample !== undefined}
                  onclick={() => void useSample(demo)}
                >
                  <span class="sample-thumb">
                    <img src={demo.url} alt="" loading="lazy" />
                  </span>
                  <span class="sample-row">
                    <span class="sample-initial" style={`background:${accentFill(demo.accent)};`}>
                      {demo.initial}
                    </span>
                    <span class="sample-text">
                      <span class="sample-name truncate">
                        {loadingSample === demo.id ? 'Loading…' : demo.name}
                      </span>
                      <span class="sample-specs">
                        {sampleSizeLabel(demo)} · {demo.width} × {demo.height}
                      </span>
                    </span>
                    <Chip tone={demo.accent} size="xs">{demo.format}</Chip>
                  </span>
                </button>
              {/if}
            {:else}
              <div class="sample-ghost" aria-hidden="true">
                <span class="sample-ghost-label">More soon</span>
              </div>
            {/if}
          {/each}
        </div>
      </div>
    </div>
  </div>

  <Ticker variant="yellow">
    {#snippet left()}
      <span class="ticker-mark" aria-hidden="true"></span>
      <span>{isCompact ? 'Nothing uploads' : '100% client-side · WebAssembly · no account'}</span>
    {/snippet}
    {#snippet right()}
      {#if !isCompact}
        <span class="ticker-cta">Let's squash</span>
      {/if}
      <span>v0.1.0</span>
    {/snippet}
  </Ticker>
</div>

<style>
  .home {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    background: var(--paper);
    color: var(--ink);
  }

  .hero {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(12, 1fr);
    gap: var(--space-6);
    padding: 72px var(--space-7) 0;
  }

  .hero-copy {
    grid-column: 1 / span 5;
    display: flex;
    flex-direction: column;
    gap: 28px;
    min-width: 0;
  }

  .hero-title {
    margin: 0;
    font-size: var(--fs-display);
    font-weight: var(--fw-heading);
    letter-spacing: var(--tracking-display);
    line-height: 0.94;
  }

  .hero-subtitle {
    margin: 0;
    font-size: var(--fs-lead);
    line-height: 1.5;
    color: var(--muted);
    max-width: 360px;
    text-wrap: pretty;
  }

  .specs {
    display: flex;
    flex-direction: column;
    border-top: var(--border-hairline);
    max-width: 360px;
  }

  .spec-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 11px 0;
    border-bottom: var(--border-hairline);
  }

  .spec-label {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono);
    text-transform: uppercase;
    color: var(--muted);
  }

  .hero-drop {
    grid-column: 6 / span 7;
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    min-width: 0;
  }

  .dropzone {
    position: relative;
    height: 424px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: var(--border-ink);
    border-radius: var(--radius-card);
    background: var(--surface);
    transition:
      border-color var(--duration-normal) var(--ease-standard),
      background var(--duration-normal) var(--ease-standard);
  }

  .dropzone.is-dragging {
    border-color: var(--accent-blue);
    background: color-mix(in srgb, var(--accent-blue) 6%, var(--surface));
  }

  .dropzone[role='button'] {
    cursor: pointer;
  }

  .dropzone-inset {
    position: absolute;
    inset: 9px;
    border-radius: var(--radius-md);
    border: 1.5px dashed var(--faint);
    pointer-events: none;
  }

  .dropzone.is-dragging .dropzone-inset {
    border-style: solid;
    border-color: var(--accent-blue);
  }

  .dropzone-content {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 18px;
    padding: var(--space-4);
    text-align: center;
  }

  .drop-icon {
    flex: none;
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--accent-blue);
    border: var(--border-ink);
    border-radius: var(--radius-lg);
    color: var(--cream);
    font-size: 24px;
    font-weight: 400;
    line-height: 1;
  }

  .drop-title {
    font-size: var(--fs-h3);
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .drop-sub {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono);
    text-transform: uppercase;
    color: var(--muted);
  }

  .drop-actions {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-1);
  }

  .notice {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    color: var(--accent-red);
  }

  .corner {
    position: absolute;
    bottom: 14px;
    font-family: var(--font-mono);
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono-wide);
    text-transform: uppercase;
    color: var(--faint);
  }

  .corner-left {
    left: 16px;
  }

  .corner-right {
    right: 16px;
  }

  .samples {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .samples-label {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .samples-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-4);
    align-items: stretch;
  }

  .sample-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px;
    border: var(--border-ink);
    border-radius: var(--radius-card);
    background: var(--surface);
    box-shadow: var(--shadow-card-soft);
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: inherit;
    transition: transform var(--duration-fast) var(--ease-standard);
  }

  .sample-card:hover:not(:disabled) {
    transform: translateY(-2px);
  }

  .sample-card:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .sample-thumb {
    position: relative;
    height: 98px;
    border: var(--border-ink);
    border-radius: var(--radius-image);
    overflow: hidden;
    background: var(--image-bed);
  }

  .sample-thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .sample-row {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }

  .sample-initial {
    flex: none;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: var(--border-ink);
    border-radius: var(--radius-input);
    color: var(--paper-white);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-lg);
    font-weight: 700;
  }

  .sample-text {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    flex: 1;
  }

  .sample-name {
    font-size: var(--fs-sm);
    font-weight: 800;
    letter-spacing: var(--tracking-tight);
  }

  .sample-specs {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-xs);
    letter-spacing: var(--tracking-mono-tight);
    text-transform: uppercase;
    color: var(--muted);
    white-space: nowrap;
  }

  .sample-ghost {
    display: flex;
    align-items: center;
    justify-content: center;
    border: var(--border-hairline);
    border-radius: var(--radius-card);
    background-image: repeating-linear-gradient(135deg, #e7e0cf 0 6px, var(--surface) 6px 12px);
  }

  .sample-ghost-label {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-xs);
    letter-spacing: var(--tracking-mono-wide);
    text-transform: uppercase;
    color: var(--faint);
    background: var(--paper);
    padding: 3px 8px;
    border-radius: var(--radius-pill);
  }

  .sample-card--compact {
    height: 92px;
    padding: 0;
    border: var(--border-hairline);
    border-radius: var(--radius-md);
    background-image: repeating-linear-gradient(135deg, #e7e0cf 0 6px, var(--surface) 6px 12px);
    box-shadow: none;
  }

  .sample-loading {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-xs);
    letter-spacing: var(--tracking-mono-wide);
    text-transform: uppercase;
    background: var(--surface);
    padding: 3px 8px;
    border-radius: var(--radius-pill);
  }

  .ticker-mark {
    width: 9px;
    height: 9px;
    flex: none;
    background: var(--ink);
    transform: rotate(45deg);
  }

  .ticker-cta {
    background: var(--ink);
    color: var(--cream);
    border-radius: var(--radius-pill);
    padding: 5px 11px;
    font-size: var(--fs-mono-xs);
    font-weight: 700;
    letter-spacing: var(--tracking-mono-wide);
  }

  @media (width <= 700px) {
    .hero {
      grid-template-columns: 1fr;
      padding: var(--space-7) var(--space-5) 0;
    }

    .hero-copy,
    .hero-drop {
      grid-column: 1 / -1;
    }

    .hero-title {
      font-size: var(--fs-h1);
      letter-spacing: var(--tracking-h1);
      line-height: 0.98;
    }

    .dropzone {
      height: 260px;
    }

    .drop-icon {
      width: 48px;
      height: 48px;
      font-size: 26px;
    }

    .drop-title {
      font-size: var(--fs-lead);
    }

    .samples-grid {
      grid-template-columns: 1fr 1fr;
      gap: var(--space-3);
    }
  }
</style>
