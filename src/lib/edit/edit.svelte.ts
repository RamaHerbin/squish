/**
 * UI-only mode store for the light-editing toolbar. Tracks nothing but which
 * tool is active, so `EditBar` and `CropOverlay` — siblings positioned in
 * different parts of the editor layout — stay in sync without either one
 * owning the other.
 *
 * Holds no image data and imports nothing from `../state` or `../compare`.
 * One instance per open editor session: create it where the editor view is
 * assembled (`createEditState()`) and pass it down as a prop.
 */

export type EditMode = 'idle' | 'cropping';

export interface EditState {
  /** Current tool. `'cropping'` is when `CropOverlay` should be visible. */
  readonly mode: EditMode;
  /** Enter crop mode. */
  startCrop(): void;
  /** Leave crop mode without implying apply or cancel — the caller already did. */
  exitCrop(): void;
  /** Flip between `'idle'` and `'cropping'` — what the toolbar button calls. */
  toggleCrop(): void;
}

export function createEditState(initialMode: EditMode = 'idle'): EditState {
  let mode = $state<EditMode>(initialMode);

  return {
    get mode() {
      return mode;
    },
    startCrop() {
      mode = 'cropping';
    },
    exitCrop() {
      mode = 'idle';
    },
    toggleCrop() {
      mode = mode === 'cropping' ? 'idle' : 'cropping';
    },
  };
}
