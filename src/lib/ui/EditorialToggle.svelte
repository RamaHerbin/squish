<script lang="ts">
  /**
   * The pill switch: ink outline on paper when off, blue fill with a paper
   * knob when on. 34×18 in the editor toolbar (Resize / Palette), 44×24 in
   * Settings.
   *
   * A real `<button role="switch">` — space/enter toggle it, screen readers
   * announce on/off. Pair it with your own visible label and pass either
   * `label` (becomes `aria-label`) or `labelledBy`.
   */
  interface Props {
    checked: boolean;
    onValue?: (checked: boolean) => void;
    /** Accessible name. Omit only when `labelledBy` is given. */
    label?: string;
    /** Id of the element that names this switch. */
    labelledBy?: string;
    /** Track width in px: 34 (compact) or 44 (settings). */
    size?: 34 | 44;
    disabled?: boolean;
    id?: string;
  }

  let {
    checked,
    onValue,
    label,
    labelledBy,
    size = 34,
    disabled = false,
    id,
  }: Props = $props();

  const track = $derived(size === 44 ? { w: 44, h: 24, knob: 18, pad: 3 } : { w: 34, h: 18, knob: 12, pad: 2 });
</script>

<button
  {id}
  type="button"
  role="switch"
  class="toggle"
  class:on={checked}
  aria-checked={checked}
  aria-label={labelledBy ? undefined : label}
  aria-labelledby={labelledBy}
  {disabled}
  style="--tw: {track.w}px; --th: {track.h}px; --knob: {track.knob}px; --pad: {track.pad}px;"
  onclick={() => onValue?.(!checked)}
>
  <span class="knob"></span>
</button>

<style>
  .toggle {
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    flex: none;
    inline-size: var(--tw);
    block-size: var(--th);
    padding: var(--pad);
    border: var(--border-ink);
    border-radius: var(--radius-pill);
    background: transparent;
    transition: background var(--duration-fast) var(--ease-standard);
  }

  .knob {
    display: block;
    inline-size: var(--knob);
    block-size: var(--knob);
    border-radius: 50%;
    background: var(--hairline);
    transition:
      transform var(--duration-fast) var(--ease-standard),
      background var(--duration-fast) var(--ease-standard);
  }

  .on {
    background: var(--accent-blue);
  }

  .on .knob {
    background: var(--paper);
    transform: translateX(calc(var(--tw) - var(--knob) - var(--pad) * 2 - 3px));
  }

  .toggle:disabled {
    opacity: 0.45;
  }

  /* Touch: a transparent halo brings the 34×18 pill up to a 44px target. */
  @media (pointer: coarse) {
    .toggle {
      position: relative;
    }

    .toggle::after {
      content: '';
      position: absolute;
      inset: calc((44px - var(--th)) / -2) calc((44px - var(--tw)) / -2);
    }
  }
</style>
