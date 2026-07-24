<script lang="ts">
  /**
   * The editorial dropdown: 34px tall, 1.5px ink border, 8px radius, Space
   * Mono 11px caps, a muted "▾" on the right and room for a secondary hint
   * ("9 TOTAL"). `shape="pill"` gives the 38/44px rounded build used in
   * Settings and the queue's preset picker; `variant="accent"` is the blue
   * filled state of the open encoder picker.
   *
   * A real `<select>` sits transparently on top of the painted control, so the
   * native popup, keyboard behaviour and screen-reader semantics are the
   * browser's — we only draw the closed state.
   */
  import type { SelectOption } from './types';

  interface Props {
    value: string;
    options: readonly SelectOption[];
    onValue?: (value: string) => void;
    /** Accessible name. Omit only when `labelledBy` is given. */
    label?: string;
    labelledBy?: string;
    /** Muted text on the left, before the value ("Preset"). */
    leadingLabel?: string;
    /** Muted text on the right, before the caret ("9 total"). */
    hint?: string;
    variant?: 'outline' | 'accent';
    shape?: 'input' | 'pill';
    /** Control height in px. 34 = toolbar, 38 = settings row, 44 = queue bar. */
    size?: 34 | 38 | 44;
    /** Caret glyph — flip to "˄" while the consumer knows the list is open. */
    caret?: string;
    disabled?: boolean;
    fullWidth?: boolean;
    /** Fixed width, e.g. `"186px"` in the editor toolbar. */
    width?: string;
    id?: string;
    name?: string;
  }

  let {
    value,
    options,
    onValue,
    label,
    labelledBy,
    leadingLabel,
    hint,
    variant = 'outline',
    shape = 'input',
    size = 34,
    caret = '▾',
    disabled = false,
    fullWidth = false,
    width,
    id,
    name,
  }: Props = $props();

  const current = $derived(options.find((option) => option.value === value));
  const currentLabel = $derived(current?.label ?? value);
  const padding = $derived(shape === 'pill' ? (size >= 44 ? 18 : 16) : 13);

  function handleChange(event: Event & { currentTarget: HTMLSelectElement }): void {
    onValue?.(event.currentTarget.value);
  }
</script>

<div
  class="select {variant} {shape}"
  class:full={fullWidth}
  class:disabled
  style="--h: {size}px; --px: {padding}px; {width ? `--w: ${width};` : ''}"
>
  {#if leadingLabel}<span class="lead">{leadingLabel}</span>{/if}
  <span class="current">{currentLabel}</span>
  <span class="tail">
    {#if hint}<span class="hint">{hint}</span>{/if}
    <span class="caret" aria-hidden="true">{caret}</span>
  </span>
  <select
    {id}
    {name}
    {disabled}
    class="native"
    aria-label={labelledBy ? undefined : label}
    aria-labelledby={labelledBy}
    {value}
    onchange={handleChange}
  >
    {#each options as option (option.value)}
      <option value={option.value} disabled={option.disabled}>{option.label}</option>
    {/each}
  </select>
</div>

<style>
  .select {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    block-size: var(--h);
    inline-size: var(--w, auto);
    padding-inline: var(--px);
    border: var(--border-ink);
    border-radius: var(--radius-input);
    background: transparent;
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono);
    text-transform: uppercase;
    color: var(--ink);
    white-space: nowrap;
  }

  .pill {
    border-radius: var(--radius-pill);
  }

  .full {
    display: flex;
    inline-size: 100%;
  }

  .accent {
    background: var(--accent-blue);
    color: var(--paper-white);
  }

  .lead,
  .hint {
    color: var(--muted);
    font-size: var(--fs-mono-xs);
    letter-spacing: var(--tracking-mono-wide);
  }

  .accent .lead,
  .accent .hint,
  .accent .caret {
    color: var(--cream-muted);
  }

  .current {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tail {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    flex: none;
  }

  .caret {
    font-size: var(--fs-mono-sm);
    color: var(--muted);
  }

  /* The real control: invisible, but it is what the user actually operates. */
  .native {
    position: absolute;
    inset: 0;
    inline-size: 100%;
    block-size: 100%;
    margin: 0;
    padding: 0;
    border: none;
    background: transparent;
    appearance: none;
    -webkit-appearance: none;
    opacity: 0;
    cursor: pointer;
  }

  .native:disabled {
    cursor: not-allowed;
  }

  .select:has(.native:focus-visible) {
    outline: var(--focus-ring-width) solid var(--focus-ring-color);
    outline-offset: var(--focus-ring-offset);
  }

  .select:hover:not(.disabled) {
    background: var(--cream);
  }

  .accent:hover:not(.disabled) {
    background: color-mix(in srgb, var(--accent-blue) 88%, var(--ink));
  }

  .disabled {
    opacity: 0.45;
  }
</style>
