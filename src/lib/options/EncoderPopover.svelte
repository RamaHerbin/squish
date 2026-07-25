<script lang="ts">
  /**
   * The encoder picker of comp 02b: a 186px painted trigger in the toolbar
   * that opens a 296px surface list — one 34px row per encoder, each with a
   * colour mark, its mono name and an accent note chip. The selected row is
   * filled blue.
   *
   * The trigger lives inside `Popover`'s `trigger` snippet so the panel
   * anchors to it and outside-click detection recognises it.
   *
   * Keyboard: the rows are a `menu` of `menuitemradio` buttons with roving
   * tabindex — ↑/↓ move, Home/End jump, Enter/Space pick, Escape closes
   * (handled by `Popover`).
   */
  import { BrandDot, Chip, Popover } from '../ui';
  import { ENCODER_ACCENT } from '../ui/types';
  import { ENCODER_IDS, type EncoderId } from '../contracts';
  import { encoderNote } from './knobs';
  import type { EncoderPopoverProps } from './types';

  let {
    value,
    registry,
    supportedEncoderIds,
    onValue,
    width = '186px',
    placement = 'top-start',
    compact = false,
    disabled = false,
  }: EncoderPopoverProps = $props();

  let open = $state(false);
  // `bind:this` writes `null` back on unmount, hence the nullable element type.
  let rows = $state<Array<HTMLButtonElement | null>>([]);

  interface Row {
    id: EncoderId;
    label: string;
    note: string;
    accent: string;
    supported: boolean;
  }

  const list = $derived.by((): Row[] =>
    ENCODER_IDS.map((id) => ({
      id,
      label: registry[id].label,
      note: encoderNote(id),
      accent: ENCODER_ACCENT[id],
      // `identity` is a pass-through, so it never needs a feature test.
      supported: id === 'identity' || !supportedEncoderIds || supportedEncoderIds.has(id),
    })),
  );

  /** The comp's "9 total" — every real encoder, the original excluded. */
  const total = $derived(list.filter((row) => row.id !== 'identity' && row.supported).length);
  const currentLabel = $derived(registry[value].label);

  function choose(id: EncoderId): void {
    open = false;
    if (id !== value) onValue(id);
  }

  function focusRow(index: number): void {
    const count = list.length;
    if (count === 0) return;
    const next = ((index % count) + count) % count;
    rows[next]?.focus();
  }

  function handleKeydown(event: KeyboardEvent, index: number): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusRow(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusRow(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusRow(0);
        break;
      case 'End':
        event.preventDefault();
        focusRow(list.length - 1);
        break;
      default:
        break;
    }
  }
</script>

<Popover
  {open}
  onClose={() => (open = false)}
  {placement}
  width="296px"
  padding="0"
  offset={10}
  label="Choose an encoder"
>
  {#snippet trigger()}
    {#if compact}
      <button
        type="button"
        class="trigger trigger--compact"
        class:open
        {disabled}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="All encoders"
        onclick={() => (open = !open)}
      >
        <span class="caret" aria-hidden="true">{open ? '˄' : '▾'}</span>
      </button>
    {:else}
      <button
        type="button"
        class="trigger"
        class:open
        style="--trigger-w: {width};"
        {disabled}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Encoder: {currentLabel}"
        onclick={() => (open = !open)}
      >
        <span class="name">{currentLabel}</span>
        <span class="tail">
          {#if !open}<span class="hint">{total} total</span>{/if}
          <span class="caret" aria-hidden="true">{open ? '˄' : '▾'}</span>
        </span>
      </button>
    {/if}
  {/snippet}

  <div class="list" role="menu" aria-label="Encoders">
    {#each list as row, index (row.id)}
      <button
        bind:this={rows[index]}
        type="button"
        class="row"
        class:selected={row.id === value}
        role="menuitemradio"
        aria-checked={row.id === value}
        tabindex={row.id === value ? 0 : -1}
        disabled={!row.supported}
        onclick={() => choose(row.id)}
        onkeydown={(event) => handleKeydown(event, index)}
      >
        <span class="mark">
          <BrandDot accent={row.id === value ? 'ink' : row.accent} size={10} />
        </span>
        <span class="row-name">{row.label}</span>
        <span class="row-note">
          <Chip
            tone={row.id === value ? 'ink' : row.supported ? row.accent : 'muted'}
            size="xs"
          >
            {row.supported ? row.note : 'Unavailable'}
          </Chip>
        </span>
      </button>
    {/each}
  </div>
</Popover>

<style>
  /* --- Trigger (the painted 186px select of comp 02b) -------------------- */

  .trigger {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-6);
    inline-size: var(--trigger-w, 186px);
    block-size: var(--h-control);
    padding-inline: 13px;
    border: var(--border-ink);
    border-radius: var(--radius-input);
    background: transparent;
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono);
    text-transform: uppercase;
    white-space: nowrap;
  }

  .trigger:hover:not(:disabled) {
    background: var(--cream);
  }

  .trigger.open {
    background: var(--accent-blue);
    color: var(--paper-white);
  }

  .trigger.open:hover {
    background: color-mix(in srgb, var(--accent-blue) 88%, var(--ink));
  }

  .trigger:disabled {
    opacity: 0.45;
  }

  .trigger--compact {
    inline-size: var(--h-control-lg);
    block-size: var(--h-control-lg);
    padding-inline: 0;
    justify-content: center;
    border-radius: var(--radius-pill);
    color: var(--muted);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tail {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    flex: none;
  }

  .hint {
    font-size: var(--fs-mono-xs);
    letter-spacing: var(--tracking-mono-wide);
    color: var(--muted);
  }

  .caret {
    font-size: var(--fs-mono-sm);
    color: var(--muted);
  }

  .trigger.open .hint,
  .trigger.open .caret {
    color: var(--cream-muted);
  }

  /* --- List -------------------------------------------------------------- */

  .list {
    display: flex;
    flex-direction: column;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    inline-size: 100%;
    block-size: var(--h-control);
    padding-inline: var(--space-3);
    border: 0;
    border-bottom: var(--border-faint);
    background: transparent;
    color: var(--ink);
    text-align: start;
  }

  .row:last-child {
    border-bottom: 0;
  }

  .row:hover:not(:disabled) {
    background: var(--cream);
  }

  .row.selected {
    background: var(--accent-blue);
    color: var(--paper-white);
  }

  .row:disabled {
    opacity: 0.4;
  }

  .mark {
    display: inline-flex;
    inline-size: 10px;
    flex: none;
  }

  .row-name {
    flex: 1;
    min-inline-size: 0;
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono-tight);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .row-note {
    flex: none;
  }

  /* On the blue row the chip has to invert with it. */
  .row.selected .row-note :global(.chip) {
    color: var(--paper-white);
    border-color: var(--cream-faint);
  }
</style>
