<script lang="ts">
  /**
   * The app-shell header shown once a tab is open — comps 02 (Editor), 03
   * (Matrix), 04 (Queue), 05 (Settings), and the mobile 06b/06c variants.
   * `view: 'home'` only renders the compact mobile bar (06a): the desktop
   * home screen (comp 01) owns its own 64px marketing bar and never mounts
   * this component.
   *
   * Two structurally different desktop layouts, picked by `view`:
   * - `editor` — bordered cells: brand | tab strip (+ add) | nav links.
   *   This is the only view with a tab strip, because it is the only one
   *   `TabsApi` actually drives.
   * - `matrix` / `queue` / `settings` — a single flush row: brand (no dot) +
   *   `contextTitle`, a spacer, then either nav links (queue) or one action
   *   (Close × on matrix, Done on settings).
   *
   * Below 640px both collapse into the same three-cell mobile bar from comp
   * 06: back/brand on the left, a title in the middle, one action on the
   * right — matching `<Ticker>`'s breakpoint elsewhere in `$lib/ui`.
   *
   * Callback props only, no internal routing state: the caller (integration)
   * owns `view` and reacts to `onnavigate`/`onbrand`/`onback`.
   */
  import type { AppView, TabsApi } from '../contracts';
  import { BrandDot } from '../ui';

  interface Props {
    /** Current top-level screen. Drives which bar renders. */
    view: AppView;
    /** Tab strip data, `editor` view only. Omit for a `+`-only bar. */
    tabs?: TabsApi;
    /** "Matrix — art.jpg" / "Queue" / "Settings" next to the brand mark. */
    contextTitle?: string;
    /** Mobile queue title: `QUEUE · {queueCount}`. The batch queue's file count — unrelated to `tabs`. */
    queueCount?: number;
    /** A nav link (Editor/Matrix/Queue/Settings) was picked. */
    onnavigate?: (view: AppView) => void;
    /** Brand mark clicked. Defaults to `onnavigate?.('home')`. */
    onbrand?: () => void;
    /** Mobile "‹ Back". Defaults to the brand action. */
    onback?: () => void;
    /** Mobile home's "Menu". */
    onmenu?: () => void;
    /** Files picked from the "+"/"Add" file input. */
    onaddfile?: (files: FileList) => void;
    /** Matrix's "Close ×". Defaults to `onnavigate?.('editor')`. */
    onclose?: () => void;
    /** Settings' "Done". Defaults to `onnavigate?.('editor')`. */
    ondone?: () => void;
  }

  let {
    view,
    tabs,
    contextTitle,
    queueCount,
    onnavigate,
    onbrand,
    onback,
    onmenu,
    onaddfile,
    onclose,
    ondone,
  }: Props = $props();

  /** Canonical order; the current view is filtered out of whatever renders. */
  const NAV_ORDER: readonly AppView[] = ['editor', 'matrix', 'queue', 'settings'];
  const VIEW_LABEL: Readonly<Record<AppView, string>> = {
    home: 'Home',
    editor: 'Editor',
    matrix: 'Matrix',
    queue: 'Queue',
    settings: 'Settings',
  };

  const navLinks = $derived(NAV_ORDER.filter((v) => v !== view));
  const tabList = $derived(tabs?.tabs ?? []);
  const activeId = $derived(tabs?.activeId ?? null);
  const activeTab = $derived(tabs?.active ?? null);

  function handleBrand(): void {
    if (onbrand) onbrand();
    else onnavigate?.('home');
  }

  function handleBack(): void {
    if (onback) onback();
    else handleBrand();
  }

  function handleClose(): void {
    if (onclose) onclose();
    else onnavigate?.('editor');
  }

  function handleDone(): void {
    if (ondone) ondone();
    else onnavigate?.('editor');
  }

  let fileInput = $state<HTMLInputElement | undefined>(undefined);

  function openFilePicker(): void {
    fileInput?.click();
  }

  function handleFileChange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    if (input.files && input.files.length > 0) onaddfile?.(input.files);
    input.value = '';
  }

  function handleTabClose(event: MouseEvent, id: string): void {
    event.stopPropagation();
    tabs?.close(id);
  }

  /* -------------------------------------------------------------------------- */
  /* Mobile bar (comp 06)                                                        */
  /* -------------------------------------------------------------------------- */

  const mobileTitle = $derived.by(() => {
    if (view === 'editor') return activeTab?.file.name ?? contextTitle ?? 'PINCH';
    if (view === 'queue') return `Queue · ${queueCount ?? 0}`;
    if (view === 'matrix') return contextTitle ?? 'Matrix';
    if (view === 'settings') return 'Settings';
    return '';
  });

  interface MobileAction {
    label: string;
    onClick: () => void;
  }

  const mobileAction = $derived.by((): MobileAction => {
    if (view === 'editor') return { label: 'Matrix', onClick: () => onnavigate?.('matrix') };
    if (view === 'queue') return { label: 'Add', onClick: openFilePicker };
    if (view === 'matrix') return { label: 'Close ×', onClick: handleClose };
    if (view === 'settings') return { label: 'Done', onClick: handleDone };
    return { label: '', onClick: () => {} };
  });
</script>

<header class="app-header">
  <input
    bind:this={fileInput}
    type="file"
    accept="image/*"
    multiple
    class="file-input"
    tabindex="-1"
    aria-hidden="true"
    onchange={handleFileChange}
  />

  {#if view === 'editor'}
    <div class="bar bar--cells">
      <button type="button" class="cell brand-cell" onclick={handleBrand} aria-label="Pinch — back to home">
        <BrandDot size={11} />
        <span class="brand-word">PINCH</span>
      </button>

      <div class="tab-strip" role="tablist" aria-label="Open images">
        {#each tabList as tab (tab.id)}
          {@const isActive = tab.id === activeId}
          <div class="tab-cell" class:active={isActive}>
            <button
              type="button"
              class="tab-name-btn"
              role="tab"
              aria-selected={isActive}
              title={tab.file.name}
              onclick={() => tabs?.activate(tab.id)}
            >
              {#if isActive}
                <span class="tab-dot" aria-hidden="true"></span>
              {:else if tab.dirty}
                <span class="tab-dirty" aria-hidden="true"></span>
              {/if}
              <span class="tab-name truncate">{tab.file.name}</span>
            </button>
            {#if isActive}
              <button
                type="button"
                class="tab-close"
                aria-label={`Close ${tab.file.name}`}
                onclick={(event) => handleTabClose(event, tab.id)}
              >
                ×
              </button>
            {/if}
          </div>
        {/each}
        <button type="button" class="tab-add" aria-label="Add image" onclick={openFilePicker}>+</button>
      </div>

      <nav class="cell nav-cell" aria-label="Sections">
        {#each navLinks as link (link)}
          <button type="button" class="nav-link" onclick={() => onnavigate?.(link)}>
            {VIEW_LABEL[link]}
          </button>
        {/each}
      </nav>
    </div>
  {:else if view === 'matrix' || view === 'queue' || view === 'settings'}
    <div class="bar bar--flush">
      <div class="flush-left">
        <button type="button" class="brand-plain" onclick={handleBrand} aria-label="Pinch — back to home">
          PINCH
        </button>
        {#if contextTitle}
          <span class="context-title">{contextTitle}</span>
        {/if}
      </div>

      {#if view === 'queue'}
        <nav class="nav-cell nav-cell--flush" aria-label="Sections">
          {#each navLinks as link (link)}
            <button type="button" class="nav-link" onclick={() => onnavigate?.(link)}>
              {VIEW_LABEL[link]}
            </button>
          {/each}
        </nav>
      {:else if view === 'matrix'}
        <button type="button" class="nav-link" onclick={handleClose}>Close ×</button>
      {:else}
        <button type="button" class="nav-link" onclick={handleDone}>Done</button>
      {/if}
    </div>
  {/if}

  <div class="bar bar--mobile">
    {#if view === 'home'}
      <button
        type="button"
        class="cell brand-cell brand-cell--mobile"
        onclick={handleBrand}
        aria-label="Pinch — back to home"
      >
        <BrandDot size={11} />
        <span class="brand-word">PINCH</span>
      </button>
      <button type="button" class="nav-link" onclick={() => onmenu?.()}>Menu</button>
    {:else}
      <button type="button" class="nav-link mobile-back" onclick={handleBack}>‹ Back</button>
      <span class="mobile-title truncate" class:mobile-title--queue={view === 'queue'}>{mobileTitle}</span>
      <button type="button" class="nav-link" onclick={mobileAction.onClick}>{mobileAction.label}</button>
    {/if}
  </div>
</header>

<style>
  .app-header {
    position: relative;
    flex: none;
  }

  .file-input {
    position: absolute;
    inset: 0;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  .bar {
    block-size: var(--h-topbar);
    border-bottom: var(--border-hairline);
    font-family: var(--font-mono);
  }

  button {
    font: inherit;
    letter-spacing: inherit;
  }

  /* -------------------------------------------------------------------------- */
  /* Editor — bordered cells                                                     */
  /* -------------------------------------------------------------------------- */

  .bar--cells {
    display: flex;
    align-items: stretch;
    justify-content: space-between;
  }

  .cell {
    display: flex;
    align-items: center;
    flex: none;
  }

  .brand-cell {
    gap: 10px;
    padding-inline: var(--space-6);
    border-right: var(--border-hairline);
    background: transparent;
    border-top: 0;
    border-bottom: 0;
    border-left: 0;
    color: var(--ink);
    cursor: pointer;
  }

  .brand-word {
    /* 12px matches every header in the comp; no --fs-mono-* step lands on it. */
    font-size: 12px;
    font-weight: 700;
    letter-spacing: var(--tracking-brand);
  }

  .tab-strip {
    display: flex;
    align-items: stretch;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    overscroll-behavior-x: contain;
  }

  .tab-cell {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: none;
    height: 100%;
    padding-inline: 18px;
    border-right: var(--border-hairline);
    color: var(--muted);
    font-size: var(--fs-mono-md);
    font-weight: 700;
    letter-spacing: var(--tracking-mono-tight);
  }

  .tab-cell.active {
    background: var(--accent-blue);
    color: var(--paper-white);
  }

  .tab-name-btn {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    max-width: 22ch;
    background: none;
    border: 0;
    padding: 0;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    cursor: pointer;
  }

  .tab-dot {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: var(--radius-dot);
    border: var(--border-ink);
    background: var(--accent-blue);
  }

  .tab-dirty {
    flex: none;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent-blue);
  }

  .tab-close {
    background: none;
    border: 0;
    padding: 0;
    color: var(--cream-muted);
    font-size: var(--fs-mono-md);
    line-height: 1;
    cursor: pointer;
  }

  .tab-close:hover {
    color: var(--paper-white);
  }

  .tab-add {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    padding-inline: var(--space-4);
    height: 100%;
    border-right: var(--border-hairline);
    background: none;
    border-top: 0;
    border-bottom: 0;
    border-left: 0;
    color: var(--muted);
    font-size: var(--fs-title);
    line-height: 1;
    cursor: pointer;
  }

  .tab-add:hover {
    color: var(--ink);
  }

  .nav-cell {
    display: flex;
    align-items: center;
    gap: 22px;
    padding-inline: var(--space-6);
    border-left: var(--border-hairline);
  }

  .nav-link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono-wide);
    text-transform: uppercase;
    white-space: nowrap;
    cursor: pointer;
    transition: color var(--duration-fast) var(--ease-standard);
  }

  .nav-link:hover {
    color: var(--ink);
  }

  /* -------------------------------------------------------------------------- */
  /* Matrix / Queue / Settings — flush row                                       */
  /* -------------------------------------------------------------------------- */

  .bar--flush {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-inline: var(--space-6);
  }

  .flush-left {
    display: flex;
    align-items: center;
    gap: 22px;
    min-width: 0;
  }

  .brand-plain {
    background: none;
    border: 0;
    padding: 0;
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: var(--tracking-brand);
    cursor: pointer;
  }

  .context-title {
    color: var(--muted);
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono-wide);
    text-transform: uppercase;
    white-space: nowrap;
  }

  .nav-cell--flush {
    padding-inline: 0;
    border-left: 0;
  }

  /* -------------------------------------------------------------------------- */
  /* Mobile (comp 06)                                                            */
  /* -------------------------------------------------------------------------- */

  .bar--mobile {
    display: none;
    align-items: center;
    justify-content: space-between;
    padding-inline: var(--space-5);
  }

  .brand-cell--mobile {
    gap: 9px;
    padding-inline: 0;
    border-right: 0;
  }

  .mobile-title {
    flex: 1;
    min-width: 0;
    text-align: center;
    color: var(--ink);
    font-size: var(--fs-mono-md);
    font-weight: 700;
    letter-spacing: var(--tracking-mono-tight);
  }

  /* Queue's mobile title reads "QUEUE · 12" — caps + the wider tracking,
     unlike the editor's plain filename. */
  .mobile-title--queue {
    letter-spacing: var(--tracking-mono-wider);
    text-transform: uppercase;
  }

  .mobile-back {
    flex: none;
  }

  @media (width <= 640px) {
    .bar--cells,
    .bar--flush {
      display: none;
    }

    .bar--mobile {
      display: flex;
    }
  }
</style>
