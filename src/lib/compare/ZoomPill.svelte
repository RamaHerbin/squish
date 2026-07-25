<script lang="ts">
  /**
   * The viewport bar that floats at the bottom centre of the editor canvas
   * (comp "02 Editor"): `− | 100% | + | FIT | 1:1`, hairline-separated inside
   * one 1.5px ink pill — plus two segments the comp leaves to the app, rotate
   * and crop, appended in the same idiom.
   *
   * The percentage is a real text field: type `250`, press Enter. It commits on
   * `change` (Enter / blur) rather than per keystroke, so typing `5` on the way
   * to `50` does not fling the image about. While it has focus the field is
   * left alone; otherwise an effect keeps it in step with `scale`.
   *
   * Emits absolute target scales only — the anchor point of a zoom belongs to
   * the surface that owns the transform.
   */
  import { formatZoomPercent, parseZoomScale, zoomInScale, zoomOutScale } from './reveal';
  import type { ZoomPillProps } from './reveal';

  let {
    scale,
    onzoom,
    onfit,
    onrotate,
    oncrop,
    cropping = false,
    compact = false,
    disabled = false,
    class: className = '',
  }: ZoomPillProps = $props();

  let field = $state<HTMLInputElement>();

  const percentText = $derived(formatZoomPercent(scale));

  /* Mirror the transform into the field, except while it is being typed in. */
  $effect(() => {
    const input = field;
    const text = percentText;
    if (!input || input.ownerDocument.activeElement === input) return;
    input.value = text;
  });

  function commitField(): void {
    const input = field;
    if (!input) return;
    const next = parseZoomScale(input.value);
    if (next === null) {
      input.value = percentText;
      return;
    }
    onzoom(next);
  }

  function onFieldKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitField();
      field?.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (field) field.value = percentText;
      field?.blur();
    }
  }
</script>

<div class="zoom-pill {className}" class:compact class:disabled>
  <button
    type="button"
    class="segment icon-segment"
    {disabled}
    onclick={() => onzoom(zoomOutScale(scale))}
    title="Zoom out"
    aria-label="Zoom out"
  >
    <span aria-hidden="true">−</span>
  </button>

  <span class="segment value-segment">
    <input
      bind:this={field}
      class="field"
      type="text"
      inputmode="decimal"
      autocomplete="off"
      spellcheck="false"
      {disabled}
      aria-label="Zoom percentage"
      onchange={commitField}
      onkeydown={onFieldKeydown}
      onfocus={(event) => event.currentTarget.select()}
    />
    <span class="unit" aria-hidden="true">%</span>
  </span>

  <button
    type="button"
    class="segment icon-segment"
    {disabled}
    onclick={() => onzoom(zoomInScale(scale))}
    title="Zoom in"
    aria-label="Zoom in"
  >
    <span aria-hidden="true">+</span>
  </button>

  {#if onfit}
    <button
      type="button"
      class="segment text-segment"
      {disabled}
      onclick={onfit}
      title="Fit the image to the viewport"
      aria-label="Fit the image to the viewport"
    >
      FIT
    </button>
  {/if}

  <button
    type="button"
    class="segment text-segment"
    {disabled}
    onclick={() => onzoom(1)}
    title="Actual size"
    aria-label="Actual size, 100%"
  >
    1:1
  </button>

  {#if onrotate}
    <button
      type="button"
      class="segment icon-segment"
      {disabled}
      onclick={onrotate}
      title="Rotate 90°"
      aria-label="Rotate 90 degrees"
    >
      <svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M13.2 8a5.2 5.2 0 1 1-1.7-3.9" />
        <path d="M13.5 1.8v3.4h-3.4" />
      </svg>
    </button>
  {/if}

  {#if oncrop}
    <button
      type="button"
      class="segment icon-segment"
      class:active={cropping}
      {disabled}
      aria-pressed={cropping}
      onclick={oncrop}
      title="Crop"
      aria-label="Crop"
    >
      <svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M4.5 1v10.5H15" />
        <path d="M1 4.5h10.5V15" />
      </svg>
    </button>
  {/if}
</div>

<style>
  .zoom-pill {
    display: flex;
    align-items: stretch;
    height: var(--h-control-md);
    overflow: hidden;
    background: var(--paper);
    border: var(--border-ink);
    border-radius: var(--radius-pill);
    box-shadow: var(--shadow-card-soft);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
  }

  /* Nothing to zoom yet: the bar stays in place, visibly inert. */
  .zoom-pill.disabled {
    opacity: 0.55;
  }

  .segment {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    margin: 0;
    padding: 0;
    border: 0;
    border-right: var(--border-hairline);
    background: transparent;
    color: var(--ink);
    font-family: inherit;
    line-height: 1;
  }

  .segment:last-child {
    border-right: 0;
  }

  .icon-segment,
  .text-segment {
    width: 38px;
    transition:
      background var(--duration-fast) var(--ease-standard),
      color var(--duration-fast) var(--ease-standard);
  }

  .text-segment {
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono-tight);
    color: var(--muted);
  }

  button.segment:hover:not(:disabled) {
    background: var(--cream);
  }

  button.segment:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring-color);
    outline-offset: calc(var(--focus-ring-offset) * -1);
  }

  button.segment:disabled {
    color: var(--faint);
  }

  .active,
  .active:hover:not(:disabled) {
    background: var(--ink);
    color: var(--cream);
  }

  .value-segment {
    gap: 1px;
    padding: 0 8px;
    letter-spacing: var(--tracking-mono-tight);
  }

  .field {
    width: 34px;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: inherit;
    letter-spacing: inherit;
    text-align: right;
  }

  .field:focus {
    outline: none;
  }

  .value-segment:focus-within {
    background: var(--cream);
  }

  .unit {
    color: var(--muted);
  }

  .icon {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* ---- 390px ------------------------------------------------------- */

  .compact {
    height: var(--h-control);
    font-size: var(--fs-mono-md);
  }

  .compact .icon-segment,
  .compact .text-segment {
    width: 32px;
  }

  .compact .text-segment {
    font-size: var(--fs-mono-sm);
  }

  .compact .value-segment {
    padding: 0 6px;
  }

  .compact .field {
    width: 30px;
  }

  /* Fingers need more than 38px of pill; the rules repeat inside the query so
     the compact variant is not left winning on specificity. */
  @media (pointer: coarse) {
    .icon-segment,
    .text-segment {
      width: 42px;
    }

    .compact .icon-segment,
    .compact .text-segment {
      width: 38px;
    }
  }
</style>
