<script lang="ts" module>
  let counter = 0;

  function nextId(): number {
    counter += 1;
    return counter;
  }
</script>

<script lang="ts">
  /**
   * The one slider in the design: 3px rail, ink fill to the left of the thumb,
   * 14px round blue thumb, an optional 0/25/50/75/100 tick row, and a header
   * that pairs a mono caps label with a big mono value.
   *
   * Replaces the old `RangeField` pattern. There is a real `<input
   * type="range">` underneath — keyboard, screen readers and touch all work;
   * the rail and fill are decoration painted behind it, aligned to the native
   * thumb centre so they never drift at the ends.
   *
   * Controlled: pass `value` and handle `onValue`. The DOM input is free to
   * run ahead while dragging, which is what makes it feel native.
   */
  import type { Snippet } from 'svelte';

  interface Props {
    value: number;
    min?: number;
    max?: number;
    step?: number;
    /** Mono caps label in the header row. Omit for a bare slider. */
    label?: string;
    /** Formatted value for the header. Defaults to the raw number. */
    valueText?: string;
    /** Fired on every input event with the new numeric value. */
    onValue?: (value: number) => void;
    /** Fired once the drag/keyboard interaction settles (native `change`). */
    onCommit?: (value: number) => void;
    disabled?: boolean;
    /** Explicit tick labels under the rail. */
    ticks?: readonly (string | number)[];
    /** Shorthand for five evenly spaced ticks across `min…max`. */
    showTicks?: boolean;
    /** `md` = 14px thumb (desktop), `lg` = 20px thumb (touch). */
    size?: 'md' | 'lg';
    /** Header row, right of the label and left of the value ("Advanced ›"). */
    accessory?: Snippet;
    /** Hide the numeric readout (when the value is shown elsewhere). */
    hideValue?: boolean;
    /** Required when `label` is omitted. */
    ariaLabel?: string;
    /** Spoken value, e.g. "quality 52 of 100". */
    ariaValueText?: string;
    id?: string;
    name?: string;
  }

  let {
    value,
    min = 0,
    max = 100,
    step = 1,
    label,
    valueText,
    onValue,
    onCommit,
    disabled = false,
    ticks,
    showTicks = false,
    size = 'md',
    accessory,
    hideValue = false,
    ariaLabel,
    ariaValueText,
    id,
    name,
  }: Props = $props();

  const uid = `pinch-slider-${nextId()}`;
  const inputId = $derived(id ?? uid);

  const span = $derived(max - min || 1);
  const pct = $derived(Math.min(1, Math.max(0, (value - min) / span)));
  const thumb = $derived(size === 'lg' ? 20 : 14);

  const tickLabels = $derived.by((): readonly (string | number)[] => {
    if (ticks) return ticks;
    if (!showTicks) return [];
    return [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(min + span * f));
  });

  function handleInput(event: Event & { currentTarget: HTMLInputElement }): void {
    onValue?.(Number(event.currentTarget.value));
  }

  function handleChange(event: Event & { currentTarget: HTMLInputElement }): void {
    onCommit?.(Number(event.currentTarget.value));
  }
</script>

<div class="slider" class:disabled style="--thumb: {thumb}px; --pct: {pct};">
  {#if label || accessory || !hideValue}
    <div class="header">
      {#if label}
        <label class="mono-label" for={inputId}>{label}</label>
      {:else}
        <span class="spacer"></span>
      {/if}
      <div class="header-end">
        {#if accessory}{@render accessory()}{/if}
        {#if !hideValue}
          <output class="value" for={inputId}>{valueText ?? value}</output>
        {/if}
      </div>
    </div>
  {/if}

  <div class="track">
    <div class="rail" aria-hidden="true"></div>
    <div class="fill" aria-hidden="true"></div>
    <input
      id={inputId}
      {name}
      type="range"
      {min}
      {max}
      {step}
      {value}
      {disabled}
      aria-label={label ? undefined : ariaLabel}
      aria-valuetext={ariaValueText}
      oninput={handleInput}
      onchange={handleChange}
    />
  </div>

  {#if tickLabels.length > 0}
    <div class="ticks" aria-hidden="true">
      {#each tickLabels as tick, index (index)}
        <span>{tick}</span>
      {/each}
    </div>
  {/if}
</div>

<style>
  .slider {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-inline-size: 0;
  }

  .header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-6);
  }

  .header label {
    white-space: nowrap;
    cursor: pointer;
  }

  .spacer {
    flex: 1;
  }

  .header-end {
    display: flex;
    align-items: center;
    gap: 18px;
    flex: none;
  }

  .value {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-xl);
    font-weight: 700;
    letter-spacing: var(--tracking-tight);
    min-inline-size: 30px;
    text-align: right;
  }

  .track {
    position: relative;
    display: flex;
    align-items: center;
    block-size: var(--thumb);
  }

  .rail,
  .fill {
    position: absolute;
    block-size: 3px;
    border-radius: var(--radius-pill);
    pointer-events: none;
  }

  .rail {
    inset-inline: 0;
    background: var(--hairline);
  }

  /* Ends at the native thumb's centre, so paint and control never disagree. */
  .fill {
    inset-inline-start: 0;
    inline-size: calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--pct));
    background: var(--ink);
  }

  input[type='range'] {
    position: relative;
    appearance: none;
    -webkit-appearance: none;
    inline-size: 100%;
    block-size: var(--thumb);
    margin: 0;
    background: transparent;
    cursor: pointer;
  }

  input[type='range']:disabled {
    cursor: not-allowed;
  }

  input[type='range']::-webkit-slider-runnable-track {
    block-size: 3px;
    background: transparent;
    border: none;
  }

  input[type='range']::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    inline-size: var(--thumb);
    block-size: var(--thumb);
    border: none;
    border-radius: 50%;
    background: var(--accent-blue);
    margin-block-start: calc((3px - var(--thumb)) / 2);
  }

  input[type='range']::-moz-range-track {
    block-size: 3px;
    background: transparent;
    border: none;
  }

  input[type='range']::-moz-range-thumb {
    inline-size: var(--thumb);
    block-size: var(--thumb);
    border: none;
    border-radius: 50%;
    background: var(--accent-blue);
  }

  /* The ring belongs on the thumb, not the full-width input box. */
  input[type='range']:focus {
    outline: none;
  }

  input[type='range']:focus-visible::-webkit-slider-thumb {
    outline: var(--focus-ring-width) solid var(--focus-ring-color);
    outline-offset: var(--focus-ring-offset);
  }

  input[type='range']:focus-visible::-moz-range-thumb {
    outline: var(--focus-ring-width) solid var(--focus-ring-color);
    outline-offset: var(--focus-ring-offset);
  }

  .ticks {
    display: flex;
    justify-content: space-between;
    font-family: var(--font-mono);
    font-size: var(--fs-mono-xs);
    letter-spacing: var(--tracking-mono-wide);
    color: var(--faint);
  }

  .disabled {
    opacity: 0.5;
  }

  /* Touch: keep the 14px thumb, grow the grab area to a comfortable 28px. */
  @media (pointer: coarse) {
    .track {
      block-size: max(var(--thumb), 28px);
    }

    input[type='range'] {
      block-size: max(var(--thumb), 28px);
    }
  }
</style>
