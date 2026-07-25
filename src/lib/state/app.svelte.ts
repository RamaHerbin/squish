/**
 * App-shell state: which view is on screen, and who owns the editor session.
 *
 * Small on purpose. It exists because `mode` and the `JobSession` have to
 * outlive any one component — a file dropped on the intro screen has to flip the
 * app to `editor` *and* hand the file to a session that did not exist a moment
 * ago — and because the session needs a worker bridge that only the codec layer
 * can supply. Hence {@link AppState.configure}: the shell injects the factory
 * once at start-up, and everything downstream just calls `openFiles()`.
 *
 * If the integrator already has an app store, ignore this file; `JobSession`
 * from `session.svelte.ts` stands alone.
 */

import { isAppMode } from '../contracts';
import type {
  AppMode,
  CreateWorkerBridge,
  EncoderRegistry,
  JobEventListener,
  SideSettings,
} from '../contracts';
import { JobSession } from './session.svelte';
import type { EngineHooks, SettingsPersistence } from './engine';

export interface AppStateConfig {
  /** Required before an editor session can start. One worker per side. */
  createBridge: CreateWorkerBridge;
  hooks?: Partial<EngineHooks>;
  registry?: EncoderRegistry;
  persistence?: SettingsPersistence;
  /** Restored settings, typically `await persistence.load()`. */
  initialSides?: [SideSettings, SideSettings];
  debounceMs?: number;
  onEvent?: JobEventListener;
}

export class AppState {
  mode: AppMode = $state<AppMode>('intro');
  /** Files waiting for the batch view. Replaced, never mutated in place. */
  batchFiles: File[] = $state<File[]>([]);
  /** Surfaces "that file was not an image" before a session even exists. */
  error: string | undefined = $state<string | undefined>(undefined);

  #config: AppStateConfig | undefined;
  #session: JobSession | undefined = $state<JobSession | undefined>(undefined);

  /** Call once, from the app shell, before opening anything. */
  configure(config: AppStateConfig): void {
    this.#config = config;
  }

  get configured(): boolean {
    return this.#config !== undefined;
  }

  /** The live editor session, if one has been started. */
  get session(): JobSession | undefined {
    return this.#session;
  }

  /** Create the session on demand; the workers spin up with it. */
  ensureSession(): JobSession {
    const config = this.#config;
    if (!config) {
      throw new Error('appState.configure({ createBridge }) must run before opening a file');
    }
    const existing = this.#session;
    if (existing) return existing;

    const session = new JobSession({
      createBridge: config.createBridge,
      hooks: config.hooks,
      registry: config.registry,
      persistence: config.persistence,
      initialSides: config.initialSides,
      debounceMs: config.debounceMs,
      onEvent: config.onEvent,
    });
    this.#session = session;
    return session;
  }

  setMode(mode: AppMode): void {
    if (!isAppMode(mode)) return;
    this.mode = mode;
  }

  /** One image goes to the compare editor. */
  openFile(file: File): void {
    this.error = undefined;
    this.batchFiles = [];
    const session = this.ensureSession();
    this.mode = 'editor';
    session.setSource(file);
  }

  /**
   * Drop target entry point. One file is an editing session; several is a batch
   * job — the distinction the whole app hangs off, made in one place.
   */
  openFiles(files: readonly File[]): void {
    const list = [...files];
    if (list.length === 0) return;
    const first = list[0];
    if (list.length === 1 && first) {
      this.openFile(first);
      return;
    }
    this.error = undefined;
    this.batchFiles = list;
    this.mode = 'batch';
  }

  /** Back to the drop zone: tear the session down so its workers go with it. */
  reset(): void {
    this.#session?.dispose();
    this.#session = undefined;
    this.batchFiles = [];
    this.error = undefined;
    this.mode = 'intro';
  }
}

/** The shared instance. Import this from components. */
export const appState = new AppState();
