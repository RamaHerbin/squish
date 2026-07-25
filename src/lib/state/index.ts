/**
 * The state layer: the reactive job engine, its pure orchestration core, the
 * result cache, and settings persistence.
 *
 * ```ts
 * import { JobSession, createSettingsPersistence } from './lib/state';
 * ```
 *
 * Nothing here imports a codec or a worker directly — the worker bridge and the
 * platform hooks are constructor arguments, which is what lets the whole engine
 * run under vitest with fakes and no DOM.
 */

export { JobSession, createJobSession } from './session.svelte';
export type { JobSessionOptions } from './session.svelte';

export { AppState, appState } from './app.svelte';
export type { AppStateConfig } from './app.svelte';

export { LruResultCache, createResultCache } from './result-cache';

export {
  ENCODER_OUTPUT_MIME,
  SourceUnavailableError,
  assertNotDetached,
  cloneImageData,
  createDefaultEngineHooks,
  createImageData,
  createObjectUrl,
  defaultCrop,
  defaultDecodeOutput,
  defaultDecodeSource,
  defaultEncodeBrowser,
  defaultResizeOnMainThread,
  effectiveProcessorState,
  normaliseSvg,
  outputFileName,
  outputFor,
  planWork,
  resizeOptionsFrom,
  revokeObjectUrl,
  runDecode,
  runDecodeOutput,
  runEncode,
  runPreprocess,
  runProcess,
  seedResizeState,
  sniffFile,
  swapResizeDimensions,
  toError,
} from './engine';
export type {
  DesiredJobs,
  EngineHooks,
  JobSnapshot,
  MainJob,
  SettingsPersistence,
  SideJob,
  SideWork,
  WorkPlan,
} from './engine';

export {
  SETTINGS_SAVE_DEBOUNCE_MS,
  SIDE_SETTINGS_KEY_PREFIX,
  clearSideSettings,
  createIdbStore,
  createMemoryStore,
  createSettingsPersistence,
  loadAllSideSettings,
  loadSideSettings,
  sanitizeSideSettings,
  saveSideSettings,
  sideSettingsKey,
} from './settings-persistence';
export type {
  KeyValueStore,
  SettingsPersistenceHandle,
  SettingsPersistenceOptions,
} from './settings-persistence';
