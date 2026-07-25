/**
 * Shared contracts for squish. Ground truth for every feature module.
 *
 * Import from the barrel:
 * ```ts
 * import { createSideSettings, type SideSettings } from '$lib/contracts';
 * ```
 *
 * Nothing here imports a runtime dependency — only types and small pure
 * helpers — so a contract can be pulled into the main thread, a worker, or a
 * test without dragging wasm along.
 */

export * from './image';
export * from './codecs';
export * from './processing';
export * from './jobs';
export * from './worker';
export * from './presets';
export * from './batch';
export * from './pinch';
export * from './version';

/* -------------------------------------------------------------------------- */
/* App shell                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Top-level view.
 *
 * - `intro` — drop zone, before any image is loaded
 * - `editor` — single image, two-up compare
 * - `batch`  — many images, one settings snapshot
 */
export type AppMode = 'intro' | 'editor' | 'batch';

export const APP_MODES: readonly AppMode[] = ['intro', 'editor', 'batch'];

export function isAppMode(value: unknown): value is AppMode {
  return value === 'intro' || value === 'editor' || value === 'batch';
}
