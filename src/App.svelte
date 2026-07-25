<script lang="ts">
  /**
   * App shell — the composition root.
   *
   * Owns the four things nothing else can:
   *
   * 1. **The router.** One {@link AppView} over the five comps: home, editor,
   *    matrix, queue, settings.
   * 2. **The tab strip.** Each tab owns its own `JobSession`, so switching
   *    images never re-decodes and a background encode keeps running.
   * 3. **The start-up handshake.** Persisted settings → shared preset from the
   *    URL → app settings → OS share/launch file, in that order, once.
   * 4. **Dependency injection.** The state layer talks to the codec layer only
   *    through the hooks assembled here; neither imports the other.
   *
   * Everything below this file is somebody else's feature directory.
   */
  import { onDestroy, onMount, untrack } from 'svelte';

  import type {
    AppView,
    JobEngine,
    SettingsSectionId,
    SideSettings,
  } from './lib/contracts';
  import {
    FILE_PICKER_ACCEPT,
    PRESET_URL_PARAM,
    cloneSideSettings,
    createDefaultSideSettings,
    createSideSettings,
    partitionBySize,
    withEncoder,
  } from './lib/contracts';

  import {
    ENCODER_REGISTRY,
    browserEncode,
    createDefaultWorkerBridge,
    decodeFile,
    decodeToSourceImage,
  } from './lib/codecs';
  import {
    appState,
    createJobSession,
    createSettingsPersistence,
    sanitizeSideSettings,
  } from './lib/state';

  import Header from './lib/shell/Header.svelte';
  import UpdateToast from './lib/shell/UpdateToast.svelte';
  import { createTabs } from './lib/shell/tabs.svelte';
  import { consumeSharedFile } from './lib/shell/share-target';

  import HomeView from './lib/home/HomeView.svelte';
  import EditorView from './lib/EditorView.svelte';
  import { MatrixView } from './lib/matrix';
  import QueueView from './lib/batch/QueueView.svelte';
  import SettingsView from './lib/settings/SettingsView.svelte';
  import { appSettings } from './lib/settings/settings.svelte';

  import { createBatchQueue, looksLikeImage, type BatchQueueStore } from './lib/batch';
  import { initPlatform, openExternalLink } from './lib/platform';
  import { readPresetFromLocation } from './lib/presets';
  import { disposeSharedMetricsClient, getSharedMetricsClient } from './lib/metrics';

  import { BrandDot, PillButton } from './lib/ui';

  /* ------------------------------------------------------------------ */
  /* Wiring                                                              */
  /* ------------------------------------------------------------------ */

  const persistence = createSettingsPersistence();

  /**
   * The state layer is deliberately codec-agnostic; these three hooks are the
   * whole of the seam. `createBridge` is called twice per session (one worker
   * per side) so aborting one side never terminates the other's warm wasm.
   */
  const hooks = {
    decodeSource: (
      signal: AbortSignal,
      file: File,
      bridge: ReturnType<typeof createDefaultWorkerBridge>,
    ) => decodeToSourceImage(signal, file, { bridge }),
    decodeOutput: async (
      signal: AbortSignal,
      file: File,
      bridge: ReturnType<typeof createDefaultWorkerBridge>,
    ) => (await decodeFile(signal, file, { bridge })).data,
    encodeBrowser: browserEncode,
  };

  const baseConfig = {
    createBridge: createDefaultWorkerBridge,
    registry: ENCODER_REGISTRY,
    persistence,
    hooks,
  };

  /**
   * Handed to the editor so auto-suggest probes through the same codecs the
   * sessions encode with. Structurally typed at the call site — `EditorView`
   * owns the shape.
   */
  const pipeline = {
    createBridge: createDefaultWorkerBridge,
    hooks,
    registry: ENCODER_REGISTRY,
  };

  // Configure immediately so a drop during start-up still works; the async pass
  // below reconfigures with the restored settings.
  appState.configure(baseConfig);

  const metricsClient = getSharedMetricsClient();

  /** Stable identity: `MatrixView` captures this once, when it mounts. */
  async function measureSsim(
    original: ImageData,
    encoded: ImageData,
    signal?: AbortSignal,
  ): Promise<number | null> {
    const result = await metricsClient.measure(original, encoded, signal);
    return result.ssim;
  }

  /* ------------------------------------------------------------------ */
  /* Initial settings                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Side 1's starting configuration: a shared preset from the URL beats
   * persisted settings, which beat the app-wide default encoder. Plain, not
   * `$state` — it is read when a session is minted, never rendered.
   */
  let initialSideOne: SideSettings | undefined;

  /** Side 0 is *always* `identity`: it is the original half of the reveal. */
  function initialSides(): [SideSettings, SideSettings] {
    if (initialSideOne) return [createSideSettings('identity'), cloneSideSettings(initialSideOne)];
    return [
      createSideSettings('identity'),
      // The generic collapses to the whole union for a non-literal id, so the
      // return type widens; at runtime it really is one specific encoder.
      withEncoder(createDefaultSideSettings(1), appSettings.current.defaultEncoder) as SideSettings,
    ];
  }

  /* ------------------------------------------------------------------ */
  /* Tabs                                                                */
  /* ------------------------------------------------------------------ */

  const tabs = createTabs({
    createSession(file: File): JobEngine {
      const session = createJobSession({ ...baseConfig, initialSides: initialSides() });
      session.setSource(file);
      return session;
    },
    disposeSession(session: JobEngine): void {
      session.dispose();
    },
  });

  const activeTab = $derived(tabs.active);

  /* ------------------------------------------------------------------ */
  /* Router                                                              */
  /* ------------------------------------------------------------------ */

  let view = $state<AppView>('home');
  /** Where `Done` on the settings screen goes back to. */
  let returnView: AppView = 'home';
  let settingsSection = $state<SettingsSectionId>('defaults');
  let starting = $state(true);

  function go(next: AppView): void {
    shellError = undefined;
    // The editor has nothing to show without a tab; the matrix needs one too.
    if ((next === 'editor' || next === 'matrix') && !tabs.active) {
      view = 'home';
      return;
    }
    if (next === 'settings' && view !== 'settings') returnView = view;
    view = next;
  }

  function openSettings(section: SettingsSectionId): void {
    settingsSection = section;
    go('settings');
  }

  /* ------------------------------------------------------------------ */
  /* Opening files                                                       */
  /* ------------------------------------------------------------------ */

  let shellError = $state<string | undefined>(undefined);

  /**
   * Shared ingestion gate: keep readable images within the advertised 50 MB
   * limit, and explain anything dropped.
   */
  function imagesOf(files: readonly File[]): { images: File[]; skippedNote?: string } {
    const { accepted, oversized } = partitionBySize(files.filter((f) => looksLikeImage(f)));
    if (oversized.length === 0) return { images: accepted };
    const names = oversized.map((f) => f.name).join(', ');
    return { images: accepted, skippedNote: `Skipped (over 50 MB): ${names}` };
  }

  /** Every file becomes a tab. Used by the header `+` and the share target. */
  function openInEditor(files: readonly File[]): void {
    const { images, skippedNote } = imagesOf(files);
    if (images.length === 0) {
      shellError =
        skippedNote ??
        (files.length > 0 ? 'That file is not an image Pinch can read.' : undefined);
      return;
    }
    shellError = skippedNote;
    tabs.openMany(images);
    view = 'editor';
  }

  /** The home drop zone: one image is an editing session, several is a queue. */
  function handleHomeFiles(files: readonly File[]): void {
    const { images, skippedNote } = imagesOf(files);
    if (images.length === 0) {
      shellError =
        skippedNote ?? (files.length > 0 ? 'No readable images in that drop.' : undefined);
      return;
    }
    if (images.length === 1) {
      shellError = skippedNote;
      tabs.openMany(images);
      view = 'editor';
      return;
    }
    shellError = skippedNote;
    ensureQueue().add(images);
    view = 'queue';
  }

  /* ------------------------------------------------------------------ */
  /* Drop / paste outside home and the queue                             */
  /* ------------------------------------------------------------------ */

  /**
   * `HomeView` owns the whole page while it is mounted and `QueueView` brings
   * its own document-level handlers, so these only cover the editor, matrix and
   * settings screens — where the browser default (navigate away to the dropped
   * file) is the single most destructive thing that can happen to unsaved work.
   */
  const windowDropTarget = $derived(view === 'editor' || view === 'matrix' || view === 'settings');

  function onWindowDragOver(event: DragEvent): void {
    if (!windowDropTarget) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  function onWindowDrop(event: DragEvent): void {
    if (!windowDropTarget) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) openInEditor(files);
  }

  function onWindowPaste(event: ClipboardEvent): void {
    if (!windowDropTarget) return;
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    openInEditor(files);
  }

  /**
   * ⌘K / Ctrl+K opens the file picker. Not advertised anywhere in the UI (no
   * command palette exists to attach the chip to) — kept as an unlisted
   * power-user shortcut only.
   */
  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key !== 'k' && event.key !== 'K') return;
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    event.preventDefault();
    filePicker?.click();
  }

  let filePicker = $state<HTMLInputElement | undefined>(undefined);

  function onPickerChange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length > 0) handleHomeFiles(files);
  }

  /* ------------------------------------------------------------------ */
  /* Batch queue                                                         */
  /* ------------------------------------------------------------------ */

  let queue = $state<BatchQueueStore | undefined>(undefined);
  /** Set only once the user picks a preset for the batch; otherwise derived. */
  let queueSettingsOverride = $state<SideSettings | undefined>(undefined);

  function ensureQueue(): BatchQueueStore {
    const existing = untrack(() => queue);
    if (existing) return existing;
    const created = createBatchQueue({
      createWorkerBridge: createDefaultWorkerBridge,
      registry: ENCODER_REGISTRY,
      // App-wide worker budget: the same number the matrix sweep uses.
      concurrency: appSettings.current.workerThreads,
    });
    queue = created;
    return created;
  }

  $effect(() => {
    if (view === 'queue') ensureQueue();
  });

  /**
   * Lane count is fixed when the queue is built, so a change in Settings can
   * only take effect by rebuilding it — which is safe exactly while the queue
   * is empty, idle, and not the screen the user is looking at.
   */
  $effect(() => {
    const threads = appSettings.current.workerThreads;
    untrack(() => {
      const store = queue;
      if (!store || view === 'queue') return;
      if (store.concurrency === threads) return;
      if (store.running || store.items.length > 0) return;
      store.dispose();
      queue = undefined;
    });
  });

  /** The batch snapshot: an applied preset, else whatever the editor is on. */
  const queueSettings = $derived.by((): SideSettings => {
    const override = queueSettingsOverride;
    if (override) return override;
    const settings = tabs.active?.session.state.sides[1].latestSettings;
    // Always a plain clone: `latestSettings` is a `$state` proxy, and a proxy
    // cannot be structured-cloned into a codec worker.
    return settings ? cloneSideSettings(settings) : initialSides()[1];
  });

  /* ------------------------------------------------------------------ */
  /* Start-up                                                            */
  /* ------------------------------------------------------------------ */

  function stripPresetParam(): void {
    if (typeof history === 'undefined' || typeof location === 'undefined') return;
    const url = new URL(location.href);
    if (!url.searchParams.has(PRESET_URL_PARAM)) return;
    url.searchParams.delete(PRESET_URL_PARAM);
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }

  onMount(() => {
    let cancelled = false;

    void (async () => {
      let restored: [SideSettings, SideSettings] | undefined;
      try {
        restored = await persistence.load();
      } catch {
        restored = undefined;
      }
      if (restored) initialSideOne = restored[1];

      const preset = await readPresetFromLocation();
      if (preset) {
        // A shared link is attacker-controllable and its options go straight to
        // wasm — rebuild it from the contract defaults rather than trusting it.
        initialSideOne = sanitizeSideSettings(preset.side) ?? createDefaultSideSettings(1);
        stripPresetParam();
      }

      await appSettings.ready.catch(() => undefined);
      if (cancelled) return;

      appState.configure({ ...baseConfig, initialSides: initialSides() });

      // A file dropped mid-start-up missed the settings window — apply them by
      // hand, but never over something the user has already touched.
      for (const tab of tabs.tabs) {
        if (!tab.dirty) tab.session.updateSide(1, initialSides()[1]);
      }
      starting = false;

      const shared = await consumeSharedFile();
      if (!cancelled && shared) openInEditor([shared]);
    })();

    return () => {
      cancelled = true;
    };
  });

  /**
   * Native intake. A no-op in the browser.
   *
   * Its own `onMount` on purpose: the start-up handshake above is a long async
   * chain, and macOS can hand us a cold-launch file before any of it resolves.
   * `initPlatform` subscribes first and drains the Rust-side buffer second, so
   * "Open With Pinch" on a closed app lands in the same `openInEditor` a drop
   * on the window would. Files can arrive again at any time (Dock drop, second
   * launch), each batch additive.
   */
  onMount(() =>
    initPlatform({
      onFiles: (files) => openInEditor(files),
      onError: (message) => {
        shellError = message;
      },
    }),
  );

  onDestroy(() => {
    queue?.dispose();
    tabs.closeAll();
    persistence.dispose();
    disposeSharedMetricsClient();
  });
</script>

<svelte:window
  ondragover={onWindowDragOver}
  ondrop={onWindowDrop}
  onpaste={onWindowPaste}
  onkeydown={onWindowKeydown}
/>

<div class="app">
  <input
    bind:this={filePicker}
    type="file"
    accept={FILE_PICKER_ACCEPT}
    multiple
    class="file-picker"
    tabindex="-1"
    aria-hidden="true"
    onchange={onPickerChange}
  />

  {#if view === 'home'}
    <!-- Comp 01's own 64px marketing bar; the shell `Header` covers the rest. -->
    <div class="home-bar">
      <div class="home-brand">
        <BrandDot size={13} />
        <span class="home-word">PINCH</span>
      </div>
      <nav class="home-nav" aria-label="About Pinch">
        {#if tabs.tabs.length > 0}
          <button type="button" class="home-link" onclick={() => go('editor')}>Editor</button>
        {/if}
        <button type="button" class="home-link" onclick={() => openSettings('about')}>
          How it works
        </button>
        <button type="button" class="home-link" onclick={() => openSettings('encoders')}>
          Formats
        </button>
        <!-- `openExternalLink` is inert on the web; under Tauri it keeps the
             app window from navigating to GitHub with no way back. -->
        <a
          class="home-link"
          href="https://github.com/RamaHerbin/squish"
          target="_blank"
          rel="noopener noreferrer"
          onclick={openExternalLink}
        >
          Source
        </a>
      </nav>
    </div>
  {/if}

  <Header
    {view}
    tabs={view === 'editor' ? tabs : undefined}
    contextTitle={view === 'matrix'
      ? `Matrix — ${activeTab?.file.name ?? ''}`
      : view === 'queue'
        ? 'Queue'
        : view === 'settings'
          ? 'Settings'
          : undefined}
    queueCount={queue?.items.length}
    onnavigate={go}
    onbrand={() => go('home')}
    onmenu={() => openSettings('defaults')}
    onaddfile={(files) => openInEditor(Array.from(files))}
    ondone={() => go(returnView === 'settings' ? 'home' : returnView)}
  />

  {#if shellError}
    <p class="app-error" role="alert">{shellError}</p>
  {/if}

  <main class="app-main">
    {#if view === 'home'}
      <HomeView onfiles={handleHomeFiles} onsample={(file) => openInEditor([file])} />
    {:else if view === 'editor'}
      {#if activeTab}
        {#key activeTab.id}
          <EditorView
            session={activeTab.session}
            {pipeline}
            ondirty={() => tabs.markDirty(activeTab.id, true)}
          />
        {/key}
      {:else}
        <section class="placeholder">
          <p class="placeholder-text">{starting ? 'Starting up…' : 'No image open yet.'}</p>
          <PillButton variant="solid" size={38} font="body" onclick={() => go('home')}>
            Choose an image
          </PillButton>
        </section>
      {/if}
    {:else if view === 'matrix'}
      {#if activeTab}
        <MatrixView
          source={activeTab.session.state.source?.decoded}
          originalBytes={activeTab.file.size}
          threads={appSettings.current.workerThreads}
          metrics={measureSsim}
          onopen={() => go('editor')}
          onapply={(next) => {
            const tab = tabs.active;
            if (!tab) return;
            tab.session.updateSide(1, next);
            tabs.markDirty(tab.id, true);
            view = 'editor';
          }}
        />
      {:else}
        <section class="placeholder">
          <p class="placeholder-text">Open an image to sweep it.</p>
          <PillButton variant="solid" size={38} font="body" onclick={() => go('home')}>
            Choose an image
          </PillButton>
        </section>
      {/if}
    {:else if view === 'queue'}
      {#if queue}
        <QueueView
          {queue}
          settings={queueSettings}
          registry={ENCODER_REGISTRY}
          onSettingsChange={(settings) => (queueSettingsOverride = settings)}
          onEditSettings={() => go('editor')}
        />
      {:else}
        <section class="placeholder"><p class="placeholder-text">Preparing the queue…</p></section>
      {/if}
    {:else}
      <SettingsView
        initialSection={settingsSection}
        ondone={() => go(returnView === 'settings' ? 'home' : returnView)}
      />
    {/if}
  </main>

  <!-- Mounting this is what registers the service worker. Exactly once. -->
  <UpdateToast />
</div>

<style>
  :global(body) {
    background: var(--paper);
    color: var(--ink);
  }

  .app {
    display: flex;
    flex-direction: column;
    /* Definite height, not min-height: percentage heights below (the editor's
       .reveal stage is height: 100%) resolve to 0 against an indefinite chain. */
    height: 100dvh;
    background: var(--paper);
    color: var(--ink);
  }

  .app-main {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    /* Tall views (home on short windows, settings, queue) scroll here; the
       editor lays out to fit and never triggers it. */
    overflow: auto;
  }

  .file-picker {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  /* -------------------------------------------------------------------- */
  /* Home bar (comp 01)                                                    */
  /* -------------------------------------------------------------------- */

  .home-bar {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    block-size: 64px;
    padding-inline: var(--space-7);
    border-bottom: var(--border-hairline);
  }

  .home-brand {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .home-word {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    font-weight: var(--fw-strong);
    letter-spacing: var(--tracking-brand);
  }

  .home-nav {
    display: flex;
    align-items: center;
    gap: 28px;
  }

  .home-link {
    background: none;
    border: 0;
    padding: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono-wide);
    text-transform: uppercase;
    color: var(--muted);
    white-space: nowrap;
    text-decoration: none;
    cursor: pointer;
    transition: color var(--duration-fast) var(--ease-standard);
  }

  .home-link:hover {
    color: var(--ink);
  }

  /* -------------------------------------------------------------------- */
  /* Shared                                                                */
  /* -------------------------------------------------------------------- */

  .app-error {
    flex: none;
    margin: 0;
    padding: var(--space-3) var(--space-6);
    border-bottom: var(--border-hairline);
    background: var(--surface);
    color: var(--accent-red);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono-tight);
  }

  .placeholder {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-5);
    min-height: 0;
  }

  .placeholder-text {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono-wide);
    text-transform: uppercase;
    color: var(--muted);
  }

  @media (width <= 640px) {
    .home-bar {
      display: none;
    }
  }
</style>
