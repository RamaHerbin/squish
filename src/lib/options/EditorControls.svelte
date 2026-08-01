<script lang="ts">
  /**
   * Convenience composite: the advanced drawer stacked on the toolbar for
   * desktop, the sheet for phones, and the `Advanced` open/closed state that
   * both share. Drop it at the bottom of the editor and the whole control
   * surface is wired:
   *
   * ```svelte
   * <EditorControls {registry} settings={session.latestSettings[1]} onchange={…} … />
   * ```
   *
   * Prefer the individual pieces (`AdvancedDrawer` + `Toolbar`) when the
   * editor needs to interleave something between them.
   *
   * Both builds are rendered and CSS picks one, so there is no layout flash on
   * resize and no `matchMedia` to keep in sync. The ⌘S and ⇧⌘S shortcuts are
   * registered once, by `Toolbar`, and therefore work at every width.
   */
  import AdvancedDrawer from './AdvancedDrawer.svelte';
  import MobileSheet from './MobileSheet.svelte';
  import Toolbar from './Toolbar.svelte';
  import { hasAdvanced } from './knobs';
  import type { EditorControlsData } from './types';

  interface Props extends EditorControlsData {
    /** Controlled mode: pass both to own the drawer state yourself. */
    advancedOpen?: boolean;
    onAdvancedToggle?: (open: boolean) => void;
  }

  let { advancedOpen, onAdvancedToggle, ...data }: Props = $props();

  let internalOpen = $state(false);
  const open = $derived(advancedOpen ?? internalOpen);
  const advanced = $derived(hasAdvanced(data.settings.encoderId));

  function toggle(next: boolean): void {
    internalOpen = next;
    onAdvancedToggle?.(next);
  }
</script>

<div class="controls">
  <div class="desktop">
    {#if open && advanced}
      <AdvancedDrawer
        settings={data.settings}
        onchange={data.onchange}
        registry={data.registry}
        onCollapse={() => toggle(false)}
      />
    {/if}
    <Toolbar {...data} advancedOpen={open} onAdvancedToggle={toggle} />
  </div>

  <div class="mobile">
    <MobileSheet {...data} advancedOpen={open} onAdvancedToggle={toggle} />
  </div>
</div>

<style>
  .controls {
    display: contents;
  }

  .desktop,
  .mobile {
    display: flex;
    flex-direction: column;
    flex: none;
  }

  .mobile {
    display: none;
  }

  @media (width <= 720px) {
    .desktop {
      display: none;
    }

    .mobile {
      display: flex;
    }
  }
</style>
