<script lang="ts">
  /**
   * 18px square, 5px radius. Unchecked is an ink outline; checked is a solid
   * ink fill with a cream ✓ — exactly the advanced drawer in comp 02b, where
   * the label sits left and the box right.
   *
   * A real `<input type="checkbox">` inside a `<label>`: click the text, hit
   * space, or drive it from a screen reader.
   */
  import type { Snippet } from 'svelte';

  interface Props {
    checked: boolean;
    /** Visible label text. Use `children` instead for rich content. */
    label?: string;
    children?: Snippet;
    onValue?: (checked: boolean) => void;
    /** Box first, label second (default is label first, box right). */
    reverse?: boolean;
    disabled?: boolean;
    /** Second line under the label, muted. */
    hint?: string;
    id?: string;
    name?: string;
  }

  let {
    checked,
    label,
    children,
    onValue,
    reverse = false,
    disabled = false,
    hint,
    id,
    name,
  }: Props = $props();

  function handleChange(event: Event & { currentTarget: HTMLInputElement }): void {
    onValue?.(event.currentTarget.checked);
  }
</script>

<label class="checkbox" class:reverse class:disabled>
  <span class="text">
    {#if children}{@render children()}{:else}{label}{/if}
    {#if hint}<span class="hint">{hint}</span>{/if}
  </span>
  <input
    {id}
    {name}
    type="checkbox"
    {checked}
    {disabled}
    onchange={handleChange}
  />
  <span class="box" aria-hidden="true">✓</span>
</label>

<style>
  .checkbox {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-5);
    cursor: pointer;
  }

  .reverse {
    flex-direction: row-reverse;
    justify-content: flex-end;
    gap: var(--space-3);
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: var(--fs-sm);
    line-height: 1.35;
  }

  .hint {
    font-size: var(--fs-xs);
    color: var(--muted);
  }

  /* Kept in the layout — but invisible — so focus and hit-testing stay real. */
  input {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }

  .box {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    inline-size: 18px;
    block-size: 18px;
    border: var(--border-ink);
    border-radius: var(--radius-check);
    background: transparent;
    color: transparent;
    font-size: var(--fs-mono-md);
    line-height: 1;
    transition:
      background var(--duration-fast) var(--ease-standard),
      color var(--duration-fast) var(--ease-standard);
  }

  input:checked + .box {
    background: var(--ink);
    color: var(--cream);
  }

  input:focus-visible + .box {
    outline: var(--focus-ring-width) solid var(--focus-ring-color);
    outline-offset: var(--focus-ring-offset);
  }

  .disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>
