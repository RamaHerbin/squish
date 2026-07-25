<script lang="ts">
  /**
   * Screen 05, section `/ 03`. Management surface for the same
   * `presetLibrary` singleton the editor's Advanced drawer reads from
   * (`../presets`) — CRUD, share-link, import/export and delete-with-undo,
   * restyled as ruled rows + pills instead of `PresetsPanel.svelte`'s
   * generic list treatment.
   *
   * There is no active editor tab here, so unlike `PresetsPanel.svelte` this
   * view has no "save current settings" or "apply" affordance — those stay
   * in the editor, where a `SideSettings` actually exists to save from or
   * apply to.
   */
  import { isPreset, type Preset } from '../contracts';
  import { PresetTooLargeError, buildPresetShareUrl, presetLibrary } from '../presets';
  import { BrandDot, PillButton, ENCODER_ACCENT } from '../ui';
  import { ENCODER_REGISTRY } from '../codecs';
  import { saveBlob } from '../platform';
  import SectionHeader from './SectionHeader.svelte';

  let loaded = $state(false);
  $effect(() => {
    let cancelled = false;
    presetLibrary.ready.then(() => {
      if (!cancelled) loaded = true;
    });
    return () => {
      cancelled = true;
    };
  });

  /* -------------------------------------------------------------------- */
  /* Share                                                                  */
  /* -------------------------------------------------------------------- */

  type ShareState = 'copying' | 'copied' | 'error';
  let shareStatus = $state<{ name: string; state: ShareState; message?: string } | null>(null);

  async function share(preset: Preset): Promise<void> {
    shareStatus = { name: preset.name, state: 'copying' };
    try {
      const url = await buildPresetShareUrl(preset);
      await navigator.clipboard.writeText(url);
      shareStatus = { name: preset.name, state: 'copied' };
    } catch (err) {
      const message =
        err instanceof PresetTooLargeError ? 'Too large to share.' : 'Could not copy.';
      shareStatus = { name: preset.name, state: 'error', message };
    }
  }

  $effect(() => {
    if (!shareStatus || shareStatus.state === 'copying') return;
    const timer = setTimeout(() => {
      shareStatus = null;
    }, 2000);
    return () => clearTimeout(timer);
  });

  /* -------------------------------------------------------------------- */
  /* Delete with undo                                                       */
  /* -------------------------------------------------------------------- */

  let pendingDelete = $state<Preset | null>(null);

  async function requestDelete(preset: Preset): Promise<void> {
    if (shareStatus?.name === preset.name) shareStatus = null;
    await presetLibrary.remove(preset.name);
    pendingDelete = preset;
  }

  async function undoDelete(): Promise<void> {
    const preset = pendingDelete;
    if (!preset) return;
    pendingDelete = null;
    await presetLibrary.import([preset]);
  }

  function dismissUndo(): void {
    pendingDelete = null;
  }

  $effect(() => {
    if (!pendingDelete) return;
    const timer = setTimeout(() => {
      pendingDelete = null;
    }, 5000);
    return () => clearTimeout(timer);
  });

  /* -------------------------------------------------------------------- */
  /* Import / export                                                        */
  /* -------------------------------------------------------------------- */

  let fileInput = $state<HTMLInputElement | undefined>(undefined);
  let importError = $state('');

  // Routed through the platform seam like every other save in the app: the web
  // branch is the same object-URL anchor this used to inline (click inside the
  // gesture, revoke after 60s), the macOS branch is the native save panel,
  // whose failures (full disk, revoked permission) surface in the import/export
  // error line instead of vanishing as an unhandled rejection.
  function exportPresets(): void {
    importError = '';
    const json = JSON.stringify(presetLibrary.presets, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    saveBlob('pinch-presets.json', blob).catch((error) => {
      importError = `Export failed: ${error instanceof Error ? error.message : String(error)}`;
    });
  }

  function triggerImport(): void {
    importError = '';
    fileInput?.click();
  }

  async function handleImportFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      const valid = candidates.filter(isPreset);

      if (valid.length === 0) {
        importError = 'No valid presets found in that file.';
        return;
      }
      await presetLibrary.import(valid);
      importError =
        valid.length < candidates.length
          ? `Imported ${valid.length} of ${candidates.length} — the rest were invalid and skipped.`
          : '';
    } catch {
      importError = 'Could not read that file as preset JSON.';
    }
  }
</script>

<div class="section">
  <SectionHeader accent="yellow" index={3} title="Presets" />

  <div class="toolbar">
    <span class="count mono">{presetLibrary.presets.length} total</span>
    <div class="actions">
      <PillButton size={38} variant="outline" onclick={triggerImport}>Import</PillButton>
      <PillButton
        size={38}
        variant="outline"
        onclick={exportPresets}
        disabled={presetLibrary.presets.length === 0}
      >
        Export
      </PillButton>
      <input
        bind:this={fileInput}
        type="file"
        accept="application/json"
        class="sr-only"
        onchange={handleImportFile}
      />
    </div>
  </div>

  {#if importError}<p class="message mono">{importError}</p>{/if}

  <div class="rows">
    {#if !loaded}
      <p class="empty mono">Loading presets…</p>
    {:else if presetLibrary.presets.length === 0}
      <p class="empty mono">No presets yet — save one from the editor's Advanced panel.</p>
    {:else}
      {#each presetLibrary.presets as preset (preset.name)}
        <div class="row">
          <div class="identity">
            <BrandDot accent={ENCODER_ACCENT[preset.side.encoderId]} size={13} />
            <div class="labels">
              <span class="label truncate">{preset.name}</span>
              <span class="ext mono">{ENCODER_REGISTRY[preset.side.encoderId].label}</span>
            </div>
          </div>
          <div class="row-actions">
            <PillButton size={38} variant="outline" onclick={() => share(preset)}>
              {#if shareStatus?.name === preset.name}
                {shareStatus.state === 'copying'
                  ? 'Copying…'
                  : shareStatus.state === 'copied'
                    ? 'Copied'
                    : (shareStatus.message ?? 'Error')}
              {:else}
                Share
              {/if}
            </PillButton>
            <PillButton
              size={38}
              variant="outline"
              onclick={() => requestDelete(preset)}
              ariaLabel={`Delete ${preset.name}`}
            >
              Delete
            </PillButton>
          </div>
        </div>
      {/each}
    {/if}
  </div>

  {#if pendingDelete}
    <div class="undo" role="status">
      <span class="mono">Deleted "{pendingDelete.name}"</span>
      <div class="actions">
        <PillButton size={38} variant="outline" onclick={undoDelete}>Undo</PillButton>
        <PillButton size={38} variant="outline" onclick={dismissUndo} ariaLabel="Dismiss">
          ✕
        </PillButton>
      </div>
    </div>
  {/if}
</div>

<style>
  .section {
    display: flex;
    flex-direction: column;
  }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-5);
  }

  .count {
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono-wider);
    text-transform: uppercase;
    color: var(--muted);
  }

  .actions {
    display: flex;
    gap: var(--space-2);
  }

  .message {
    font-size: var(--fs-mono-sm);
    color: var(--accent-red);
    margin-bottom: var(--space-3);
  }

  .empty {
    padding: var(--space-5) 0;
    color: var(--muted);
    font-size: var(--fs-mono-sm);
    letter-spacing: var(--tracking-mono-wide);
  }

  .rows {
    border-top: var(--border-ink);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-5);
    padding: var(--space-3) 0;
    border-bottom: var(--border-hairline);
  }

  .identity {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }

  .labels {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .label {
    font-size: var(--fs-title);
    font-weight: var(--fw-strong);
    max-width: 320px;
  }

  .ext {
    font-size: var(--fs-mono-xs);
    letter-spacing: var(--tracking-mono-wide);
    text-transform: uppercase;
    color: var(--muted);
  }

  .row-actions {
    display: flex;
    gap: var(--space-2);
    flex: none;
  }

  .undo {
    margin-top: var(--space-4);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
    border: var(--border-ink);
    border-radius: var(--radius-lg);
    background: var(--cream);
  }

  @media (width <= 640px) {
    .row {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-3);
    }

    .row-actions {
      align-self: stretch;
    }
  }
</style>
