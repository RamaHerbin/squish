<script lang="ts">
  /** Screen 05, section `/ 01` — the four rows in the comp, verbatim. */
  import { EditorialSelect, EditorialSlider, EditorialToggle } from '../ui';
  import type { SelectOption } from '../ui';
  import { WORKER_THREADS_RANGE, isEncoderId } from '../contracts';
  import { ENCODER_REGISTRY } from '../codecs';
  import { appSettings, SELECTABLE_ENCODER_IDS } from './settings.svelte';
  import SectionHeader from './SectionHeader.svelte';

  const encoderOptions: readonly SelectOption[] = SELECTABLE_ENCODER_IDS.map((id) => ({
    value: id,
    label: ENCODER_REGISTRY[id].label,
  }));

  const maxThreads = $derived(
    Math.min(
      WORKER_THREADS_RANGE.max,
      Math.max(
        WORKER_THREADS_RANGE.min,
        (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) ||
          WORKER_THREADS_RANGE.max,
      ),
    ),
  );

  function handleDefaultEncoder(next: string): void {
    if (isEncoderId(next)) appSettings.setDefaultEncoder(next);
  }
</script>

<div class="section">
  <SectionHeader accent="blue" index={1} title="Defaults" />

  <div class="rows">
    <div class="row">
      <div class="copy">
        <div class="title">Default encoder</div>
        <div class="desc">Used the moment a file lands, before you touch anything.</div>
      </div>
      <EditorialSelect
        value={appSettings.current.defaultEncoder}
        options={encoderOptions}
        onValue={handleDefaultEncoder}
        shape="pill"
        size={38}
        hint={`${SELECTABLE_ENCODER_IDS.length} total`}
        label="Default encoder"
      />
    </div>

    <div class="row">
      <div class="copy">
        <div class="title">Auto-suggest quality</div>
        <div class="desc">Picks the smallest encode still above the perceptual threshold.</div>
      </div>
      <EditorialToggle
        checked={appSettings.current.autoSuggest}
        onValue={(v) => appSettings.setAutoSuggest(v)}
        size={44}
        label="Auto-suggest quality"
      />
    </div>

    <div class="row">
      <div class="copy">
        <div class="title">Keep EXIF metadata</div>
        <div class="desc">Off strips camera, location and copyright tags from the output.</div>
        <div class="footnote mono">
          Applies to future encodes — v1 always re-encodes pixels; metadata pass-through lands
          later.
        </div>
      </div>
      <EditorialToggle
        checked={appSettings.current.keepExif}
        onValue={(v) => appSettings.setKeepExif(v)}
        size={44}
        label="Keep EXIF metadata"
      />
    </div>

    <div class="row">
      <div class="copy">
        <div class="title">Worker threads</div>
        <div class="desc">More threads encode the queue faster and heat the fans.</div>
      </div>
      <div class="thread-control">
        <EditorialSlider
          value={appSettings.current.workerThreads}
          min={WORKER_THREADS_RANGE.min}
          max={maxThreads}
          step={WORKER_THREADS_RANGE.step}
          onValue={(v) => appSettings.setWorkerThreads(v)}
          hideValue
          ariaLabel="Worker threads"
        />
        <span class="thread-value mono">{appSettings.current.workerThreads}</span>
      </div>
    </div>
  </div>
</div>

<style>
  .section {
    display: flex;
    flex-direction: column;
  }

  .rows {
    border-top: var(--border-ink);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 40px;
    padding: var(--space-5) 0;
    border-bottom: var(--border-hairline);
  }

  .copy {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .title {
    font-size: var(--fs-title);
    font-weight: var(--fw-strong);
  }

  .desc {
    font-size: var(--fs-sm);
    color: var(--muted);
  }

  .footnote {
    font-size: var(--fs-mono-xs);
    letter-spacing: var(--tracking-mono-wide);
    color: var(--faint);
    margin-top: 2px;
  }

  .thread-control {
    flex: none;
    width: 260px;
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }

  .thread-control :global(.slider) {
    flex: 1;
  }

  .thread-value {
    font-size: var(--fs-mono-lg);
    font-weight: 700;
    min-width: 20px;
    text-align: right;
  }

  @media (width <= 640px) {
    .row {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-3);
    }

    .thread-control {
      width: 100%;
    }
  }
</style>
