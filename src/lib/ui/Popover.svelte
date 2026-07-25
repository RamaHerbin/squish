<script lang="ts">
  /**
   * Anchored panel — the encoder list in comp 02b, the preset picker in the
   * queue, the ⌘K menu. Surface fill, 1.5px ink border, 12px radius, the
   * deeper "pop" shadow.
   *
   * Behaviour: closes on Escape and on any pointer press outside, traps Tab
   * inside the panel while open, moves focus in on open and back to the
   * trigger on close.
   *
   * Layout: the component owns a `position: relative` root. Put your trigger
   * button in the `trigger` snippet so the panel anchors to it:
   *
   * ```svelte
   * <Popover open={listOpen} onClose={() => (listOpen = false)} placement="top-start" width="296px">
   *   {#snippet trigger()}
   *     <PillButton onclick={() => (listOpen = !listOpen)} ariaExpanded={listOpen} ariaHasPopup>
   *       AVIF
   *     </PillButton>
   *   {/snippet}
   *   …panel content…
   * </Popover>
   * ```
   */
  import type { Snippet } from 'svelte';
  import type { PopoverPlacement } from './types';

  interface Props {
    open: boolean;
    /** Called for Escape, an outside press, or a focus-trap exit. */
    onClose: () => void;
    children: Snippet;
    /** The anchor. Optional — omit it to anchor to the parent layout instead. */
    trigger?: Snippet;
    placement?: PopoverPlacement;
    /** Panel width, e.g. `"296px"`. Defaults to fitting its content. */
    width?: string;
    /** Match the trigger's width instead of `width`. */
    matchWidth?: boolean;
    /** Gap between trigger and panel, px. */
    offset?: number;
    /** Accessible name for the panel. */
    label?: string;
    /** Inner padding; the encoder list is flush (0), menus usually are not. */
    padding?: string;
    /** Max height before the panel scrolls. */
    maxHeight?: string;
  }

  let {
    open,
    onClose,
    children,
    trigger,
    placement = 'bottom-start',
    width,
    matchWidth = false,
    offset = 8,
    label,
    padding = '0',
    maxHeight = '60vh',
  }: Props = $props();

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  let root = $state<HTMLDivElement | undefined>(undefined);
  let panel = $state<HTMLDivElement | undefined>(undefined);

  function focusables(): HTMLElement[] {
    if (!panel) return [];
    return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (element) => element.offsetParent !== null || element === panel,
    );
  }

  $effect(() => {
    if (!open) return;
    const currentPanel = panel;
    if (!currentPanel) return;

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = focusables()[0];
    (first ?? currentPanel).focus({ preventScroll: true });

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (target instanceof Node && root?.contains(target)) return;
      onClose();
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (!firstItem || !lastItem) return;

      const active = document.activeElement;
      if (event.shiftKey && (active === firstItem || active === currentPanel)) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    }

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      // Only pull focus back if it is still inside the panel we are closing.
      const active = document.activeElement;
      if (previous && (active === null || active === document.body || currentPanel.contains(active))) {
        previous.focus({ preventScroll: true });
      }
    };
  });
</script>

<div class="pop-root" bind:this={root}>
  {#if trigger}{@render trigger()}{/if}
  {#if open}
    <div
      bind:this={panel}
      class="panel {placement}"
      class:match-width={matchWidth}
      role="dialog"
      aria-label={label}
      tabindex="-1"
      style="--pop-offset: {offset}px; --pop-padding: {padding}; --pop-max-h: {maxHeight}; {width
        ? `--pop-w: ${width};`
        : ''}"
    >
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .pop-root {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .panel {
    position: absolute;
    z-index: var(--z-popover);
    inline-size: var(--pop-w, max-content);
    max-inline-size: min(92vw, 420px);
    max-block-size: var(--pop-max-h);
    overflow: hidden auto;
    overscroll-behavior: contain;
    padding: var(--pop-padding);
    background: var(--surface);
    border: var(--border-ink);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-pop);
  }

  .match-width {
    inline-size: 100%;
    min-inline-size: 100%;
  }

  .bottom-start {
    inset-block-start: calc(100% + var(--pop-offset));
    inset-inline-start: 0;
  }

  .bottom-end {
    inset-block-start: calc(100% + var(--pop-offset));
    inset-inline-end: 0;
  }

  .top-start {
    inset-block-end: calc(100% + var(--pop-offset));
    inset-inline-start: 0;
  }

  .top-end {
    inset-block-end: calc(100% + var(--pop-offset));
    inset-inline-end: 0;
  }

  .panel:focus {
    outline: none;
  }

  @media (width <= 640px) {
    .panel {
      max-inline-size: min(94vw, 360px);
    }
  }
</style>
