/**
 * Tab strip store: one entry per open image, each owning its own `JobEngine`
 * so switching tabs never re-decodes and an in-flight encode on a background
 * tab keeps running.
 *
 * Implements {@link TabsApi} from `contracts/pinch.ts` as a Svelte 5 runes
 * store — the interface is the contract, this is the one implementation.
 *
 * The store never constructs a `JobEngine` itself (contracts, and therefore
 * this file's dependents, must not depend on `state/`); the app shell injects
 * `createSession`/`disposeSession` once via {@link createTabs}.
 *
 * ```ts
 * const tabs = createTabs({
 *   createSession: (file) => createJobSession({ ... }),
 *   disposeSession: (session) => session.dispose(),
 * });
 * tabs.open(file);
 * tabs.active?.session.updateSide(1, next);
 * ```
 */

import type { JobEngine, TabState, TabsApi } from '../contracts';

export interface CreateTabsConfig {
  /** Mint a fresh engine for a newly opened file. Called at most once per tab. */
  createSession(file: File): JobEngine;
  /** Tear an engine down when its tab closes. Never called twice for the same session. */
  disposeSession(session: JobEngine): void;
}

/**
 * Monotonic, not persisted — stable only for the life of the tab, which is
 * all `{#each tabs as tab (tab.id)}` needs. A counter (rather than
 * `crypto.randomUUID`) keeps tab ids deterministic in tests.
 */
let nextTabSeq = 0;

function nextTabId(): string {
  nextTabSeq += 1;
  return `tab-${nextTabSeq}`;
}

/** Same source file, by the only signal available without reading bytes. */
function sameFile(a: File, b: File): boolean {
  return a.name === b.name && a.size === b.size;
}

class TabsStore implements TabsApi {
  #tabs = $state<TabState[]>([]);
  #activeId = $state<string | null>(null);
  readonly #createSession: (file: File) => JobEngine;
  readonly #disposeSession: (session: JobEngine) => void;

  constructor(config: CreateTabsConfig) {
    this.#createSession = config.createSession;
    this.#disposeSession = config.disposeSession;
  }

  get tabs(): readonly TabState[] {
    return this.#tabs;
  }

  get activeId(): string | null {
    return this.#activeId;
  }

  get active(): TabState | null {
    const id = this.#activeId;
    if (id === null) return null;
    return this.#tabs.find((tab) => tab.id === id) ?? null;
  }

  open(file: File): string {
    const existing = this.#tabs.find((tab) => sameFile(tab.file, file));
    if (existing) {
      this.#activeId = existing.id;
      return existing.id;
    }

    const id = nextTabId();
    const session = this.#createSession(file);
    const tab: TabState = { id, file, session, dirty: false };
    this.#tabs.push(tab);
    this.#activeId = id;
    return id;
  }

  openMany(files: readonly File[]): readonly string[] {
    const ids = files.map((file) => this.open(file));
    const first = ids[0];
    if (first !== undefined) this.#activeId = first;
    return ids;
  }

  activate(id: string): void {
    if (!this.#tabs.some((tab) => tab.id === id)) return;
    this.#activeId = id;
  }

  close(id: string): void {
    const index = this.#tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;

    const [removed] = this.#tabs.splice(index, 1);
    if (removed) this.#disposeSession(removed.session);

    if (this.#activeId !== id) return;
    // Prefer the tab that slid into this one's slot (the next tab); fall back
    // to the new last tab when the closed one was rightmost.
    const neighbour = this.#tabs[index] ?? this.#tabs[index - 1];
    this.#activeId = neighbour ? neighbour.id : null;
  }

  closeAll(): void {
    for (const tab of this.#tabs) this.#disposeSession(tab.session);
    this.#tabs = [];
    this.#activeId = null;
  }

  markDirty(id: string, dirty: boolean): void {
    const tab = this.#tabs.find((t) => t.id === id);
    if (tab) tab.dirty = dirty;
  }
}

/** Construct a fresh tab store. One per app instance. */
export function createTabs(config: CreateTabsConfig): TabsApi {
  return new TabsStore(config);
}
