<script lang="ts">
  /**
   * Screen 05 — Settings. Sidebar nav (`SettingsNav`) + a single swapped
   * panel, one component per {@link SettingsSectionId}.
   *
   * The 56px "PINCH / Settings / Done" top bar in the comp is shell chrome,
   * not this component's — this renders only the row below it (sidebar +
   * panel), and calls `ondone` on Escape so the screen is dismissible even
   * before the shell wires its own Done button.
   */
  import type { SettingsSectionId } from '../contracts';
  import SettingsNav from './SettingsNav.svelte';
  import DefaultsSection from './DefaultsSection.svelte';
  import EncodersSection from './EncodersSection.svelte';
  import PresetsSection from './PresetsSection.svelte';
  import MetricsSection from './MetricsSection.svelte';
  import ShortcutsSection from './ShortcutsSection.svelte';
  import AboutSection from './AboutSection.svelte';

  interface Props {
    /** Escape-to-close. The header's own "Done" affordance lives in the shell. */
    ondone?: () => void;
    /** Section open on mount. Defaults to the first, `defaults`. */
    initialSection?: SettingsSectionId;
  }

  let { ondone, initialSection = 'defaults' }: Props = $props();

  // Deliberate initial-value capture: initialSection only seeds the view.
  // svelte-ignore state_referenced_locally
  let active = $state<SettingsSectionId>(initialSection);

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') ondone?.();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="settings-view">
  <SettingsNav {active} onSelect={(id) => (active = id)} />

  <div class="panel">
    {#if active === 'defaults'}
      <DefaultsSection />
    {:else if active === 'encoders'}
      <EncodersSection />
    {:else if active === 'presets'}
      <PresetsSection />
    {:else if active === 'metrics'}
      <MetricsSection />
    {:else if active === 'shortcuts'}
      <ShortcutsSection />
    {:else if active === 'about'}
      <AboutSection />
    {/if}
  </div>
</div>

<style>
  .settings-view {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: stretch;
  }

  .panel {
    flex: 1;
    min-width: 0;
    padding: 44px 48px;
    max-width: 820px;
    overflow-y: auto;
  }

  @media (width <= 900px) {
    .settings-view {
      flex-direction: column;
    }

    .panel {
      padding: var(--space-6) var(--space-5);
      max-width: 100%;
    }
  }

  @media (width <= 640px) {
    .panel {
      padding: var(--space-5) var(--space-4);
    }
  }
</style>
