<script lang="ts">
  /**
   * Screen 05, section `/ 02` — read-only capability list straight off
   * `ENCODER_REGISTRY`. No comp exists for this section; it borrows the
   * Defaults section's ruled-row rhythm and the matrix/queue's per-encoder
   * dot + chip vocabulary.
   */
  import { BrandDot, Chip, ENCODER_ACCENT } from '../ui';
  import { ENCODER_REGISTRY } from '../codecs';
  import {
    EXTENSION_BY_MIME,
    isWorkerDecodableMimeType,
    PDF_MIME_TYPE,
    type ImageMimeType,
  } from '../contracts';
  import { SELECTABLE_ENCODER_IDS } from './settings.svelte';
  import SectionHeader from './SectionHeader.svelte';

  /**
   * Everything Pinch can open, derived from the same MIME table the sniffer
   * and the pickers use. Decode-only formats (HEIC and HEIF above all) live
   * here and not in the encoder list, which is why they are absent from it.
   */
  const INPUT_MIMES = Object.keys(EXTENSION_BY_MIME) as ImageMimeType[];

  const INPUT_NOTES: Partial<Record<ImageMimeType, string>> = {
    'image/heic': 'Input only. HEVC patents rule out a wasm encoder.',
    'image/heif': 'Input only, same reason as HEIC.',
    'image/svg+xml': 'Rasterised from the markup, so resizing re-renders the vector.',
  };
</script>

<div class="section">
  <SectionHeader accent="red" index={2} title="Encoders" />
  <p class="intro">
    Every codec Pinch ships, as data — pick a default on the Defaults tab.
  </p>

  <div class="rows">
    {#each SELECTABLE_ENCODER_IDS as id (id)}
      {@const meta = ENCODER_REGISTRY[id]}
      <div class="row">
        <div class="identity">
          <BrandDot accent={ENCODER_ACCENT[id]} size={13} />
          <div class="labels">
            <span class="label">{meta.label}</span>
            <span class="ext mono">.{meta.extension} · {meta.mimeType}</span>
          </div>
        </div>
        <div class="chips">
          <Chip tone="muted">{meta.usesWorker ? 'Wasm' : 'Browser'}</Chip>
          <Chip tone={meta.lossy ? 'red' : 'green'}>{meta.lossy ? 'Lossy' : 'Lossless'}</Chip>
          {#if meta.supportsAlpha}<Chip tone="ink">Alpha</Chip>{/if}
        </div>
      </div>
    {/each}
  </div>

  <h3 class="subhead">Input formats</h3>
  <p class="intro">
    Everything Pinch can open. The browser decodes what it can natively; the wasm
    decoders cover the rest. HEIC and HEIF open fine but can only be encoded to
    another format, which is why they are not in the encoder list above. PDF is
    its own screen rather than an encoder target — see the note under it.
  </p>

  <div class="rows">
    {#each INPUT_MIMES as mime (mime)}
      <div class="row">
        <div class="identity">
          <div class="labels">
            <span class="label ext-label">.{EXTENSION_BY_MIME[mime]}</span>
            <span class="ext mono">{mime}</span>
          </div>
        </div>
        <div class="chips">
          {#if mime === 'image/heic' || mime === 'image/heif'}
            <Chip tone="ink">Input only</Chip>
          {/if}
          <Chip tone="muted">
            {isWorkerDecodableMimeType(mime) ? 'Browser, wasm fallback' : 'Browser'}
          </Chip>
        </div>
      </div>
      {#if INPUT_NOTES[mime]}
        <p class="note mono">{INPUT_NOTES[mime]}</p>
      {/if}
    {/each}

    <div class="row">
      <div class="identity">
        <div class="labels">
          <span class="label ext-label">.pdf</span>
          <span class="ext mono">{PDF_MIME_TYPE}</span>
        </div>
      </div>
      <div class="chips">
        <Chip tone="ink">Own screen</Chip>
        <Chip tone="muted">Recompresses embedded images</Chip>
      </div>
    </div>
    <p class="note mono">
      Opens on the PDF screen, not in the editor. Embedded JPEG and Flate images are
      recompressed in place; text, vectors and the page count are untouched.
    </p>
  </div>
</div>

<style>
  .section {
    display: flex;
    flex-direction: column;
  }

  .intro {
    font-size: var(--fs-sm);
    color: var(--muted);
    max-width: 56ch;
    margin-bottom: var(--space-5);
  }

  .subhead {
    margin-top: var(--space-7);
    margin-bottom: var(--space-2);
    font-size: var(--fs-h4);
    font-weight: var(--fw-subhead);
    letter-spacing: var(--tracking-h3);
  }

  .ext-label {
    text-transform: uppercase;
  }

  .note {
    padding: var(--space-2) 0 var(--space-3);
    border-bottom: var(--border-faint);
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono);
    color: var(--muted);
  }

  .rows {
    border-top: var(--border-ink);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-6);
    padding: var(--space-4) 0;
    border-bottom: var(--border-hairline);
  }

  .identity {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }

  .labels {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .label {
    font-size: var(--fs-title);
    font-weight: var(--fw-strong);
  }

  .ext {
    font-size: var(--fs-mono-xs);
    letter-spacing: var(--tracking-mono-wide);
    color: var(--muted);
    text-transform: lowercase;
  }

  .chips {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: none;
  }

  @media (width <= 640px) {
    .row {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-2);
    }
  }
</style>
