<script lang="ts" module>
  let counter = 0;

  function nextUid(): string {
    counter += 1;
    return `pinch-resize-${counter}`;
  }
</script>

<script lang="ts">
  /**
   * The toolbar's `Resize` row: a mono caps label that doubles as the popover
   * trigger, plus the 34px switch from comp 02. Flipping the switch on opens
   * the panel straight away — that is where width, height, the aspect lock and
   * the resampling method live, all ported from the old `SidePanel` resize
   * section.
   *
   * The panel only exists while open, so `maintainAspect` is kept here (in the
   * always-mounted component) rather than inside it.
   */
  import { EditorialCheckbox, EditorialSelect, EditorialToggle, Popover } from '../ui';
  import type { SelectOption } from '../ui';
  import {
    RESIZE_METHODS,
    heightForWidth,
    isWorkerResizeMethod,
    widthForHeight,
    type FitMethod,
    type ResizeMethod,
    type ResizeState,
  } from '../contracts';
  import { withProcessorState } from './knobs';
  import type { ResizeControlProps } from './types';

  let {
    settings,
    onchange,
    sourceWidth,
    sourceHeight,
    placement = 'top-start',
  }: ResizeControlProps = $props();

  const uid = nextUid();

  let open = $state(false);
  let maintainAspect = $state(true);

  const resize = $derived(settings.processorState.resize);

  const RESIZE_METHOD_LABELS: Readonly<Record<ResizeMethod, string>> = {
    lanczos3: 'Lanczos3',
    mitchell: 'Mitchell',
    catrom: 'Catmull-Rom',
    triangle: 'Triangle (bilinear)',
    'browser-high': 'Browser (high quality)',
    'browser-pixelated': 'Browser (pixelated)',
  };

  const methodOptions: readonly SelectOption[] = RESIZE_METHODS.map((method) => ({
    value: method,
    label: RESIZE_METHOD_LABELS[method],
  }));

  const fitOptions: readonly SelectOption[] = [
    { value: 'stretch', label: 'Stretch' },
    { value: 'contain', label: 'Contain (crop to fit)' },
  ];

  function update(patch: Partial<ResizeState>): void {
    onchange(withProcessorState(settings, { resize: { ...resize, ...patch } }));
  }

  function setEnabled(enabled: boolean): void {
    // Seed the fields from the source the first time it is switched on.
    if (enabled && resize.width <= 1 && resize.height <= 1) {
      update({ enabled, width: sourceWidth, height: sourceHeight });
    } else {
      update({ enabled });
    }
    open = enabled;
  }

  function setWidth(width: number): void {
    const next = Math.max(1, Math.round(width));
    if (maintainAspect) {
      update({ width: next, height: heightForWidth(sourceWidth, sourceHeight, next) });
    } else {
      update({ width: next });
    }
  }

  function setHeight(height: number): void {
    const next = Math.max(1, Math.round(height));
    if (maintainAspect) {
      update({ height: next, width: widthForHeight(sourceWidth, sourceHeight, next) });
    } else {
      update({ height: next });
    }
  }

  function handleWidth(event: Event & { currentTarget: HTMLInputElement }): void {
    const next = event.currentTarget.valueAsNumber;
    if (Number.isNaN(next)) return;
    setWidth(next);
  }

  function handleHeight(event: Event & { currentTarget: HTMLInputElement }): void {
    const next = event.currentTarget.valueAsNumber;
    if (Number.isNaN(next)) return;
    setHeight(next);
  }

  function handleLabelClick(): void {
    if (!resize.enabled) {
      setEnabled(true);
      return;
    }
    open = !open;
  }
</script>

<div class="row">
  <Popover
    {open}
    onClose={() => (open = false)}
    {placement}
    width="278px"
    padding="16px"
    offset={12}
    label="Resize output"
  >
    {#snippet trigger()}
      <button
        type="button"
        class="row-label"
        aria-haspopup="dialog"
        aria-expanded={open}
        onclick={handleLabelClick}
      >
        Resize
      </button>
    {/snippet}

    <div class="panel">
      <div class="dimensions">
        <label class="field">
          <span class="mono-label mono-label--xs">Width</span>
          <input type="number" min="1" value={resize.width} oninput={handleWidth} />
        </label>
        <label class="field">
          <span class="mono-label mono-label--xs">Height</span>
          <input type="number" min="1" value={resize.height} oninput={handleHeight} />
        </label>
      </div>

      <EditorialCheckbox
        checked={maintainAspect}
        label="Lock aspect ratio"
        onValue={(next) => (maintainAspect = next)}
      />

      {#if !maintainAspect}
        <div class="field">
          <span class="mono-label mono-label--xs" id="{uid}-fit">Fit</span>
          <EditorialSelect
            value={resize.fitMethod}
            options={fitOptions}
            labelledBy="{uid}-fit"
            fullWidth
            onValue={(next) => update({ fitMethod: next as FitMethod })}
          />
        </div>
      {/if}

      <div class="field">
        <span class="mono-label mono-label--xs" id="{uid}-method">Method</span>
        <EditorialSelect
          value={resize.method}
          options={methodOptions}
          labelledBy="{uid}-method"
          fullWidth
          onValue={(next) => update({ method: next as ResizeMethod })}
        />
      </div>

      {#if isWorkerResizeMethod(resize.method)}
        <EditorialCheckbox
          checked={resize.premultiply}
          label="Premultiply alpha"
          onValue={(next) => update({ premultiply: next })}
        />
        <EditorialCheckbox
          checked={resize.linearRGB}
          label="Linear RGB"
          onValue={(next) => update({ linearRGB: next })}
        />
      {/if}
    </div>
  </Popover>

  <EditorialToggle
    checked={resize.enabled}
    label="Resize output"
    size={34}
    onValue={setEnabled}
  />
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .row-label {
    padding: 0;
    border: 0;
    background: none;
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono);
    text-transform: uppercase;
    white-space: nowrap;
  }

  .row-label:hover {
    color: var(--accent-blue);
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .dimensions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-inline-size: 0;
  }

  input[type='number'] {
    inline-size: 100%;
    block-size: var(--h-control);
    padding-inline: var(--space-3);
    border: var(--border-ink);
    border-radius: var(--radius-input);
    background: transparent;
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono-tight);
  }
</style>
