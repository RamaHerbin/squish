/**
 * Pre-processing (applies to the source, shared by both sides) and
 * processing (per-side, applied before encoding) contracts.
 *
 * Pipeline order:
 *   decode → preprocess (rotate, crop) → process (resize) → encode
 *
 * Dependency-free: types and tiny pure helpers only.
 */

import type { EncoderId, EncoderOptionsMap } from './codecs';
import { DEFAULT_ENCODER_OPTIONS } from './codecs';

/* -------------------------------------------------------------------------- */
/* Resize                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Resampling kernels.
 * `triangle` | `catrom` | `mitchell` | `lanczos3` run in the worker via
 * `@jsquash/resize`; `browser-*` use canvas `imageSmoothingQuality` and must
 * run on the main thread (or in an OffscreenCanvas the caller owns).
 */
export type ResizeMethod =
  | 'triangle'
  | 'catrom'
  | 'mitchell'
  | 'lanczos3'
  | 'browser-high'
  | 'browser-pixelated';

/** The subset of {@link ResizeMethod} that `@jsquash/resize` implements. */
export type WorkerResizeMethod = Exclude<ResizeMethod, 'browser-high' | 'browser-pixelated'>;

export const RESIZE_METHODS: readonly ResizeMethod[] = [
  'lanczos3',
  'mitchell',
  'catrom',
  'triangle',
  'browser-high',
  'browser-pixelated',
];

export function isWorkerResizeMethod(method: ResizeMethod): method is WorkerResizeMethod {
  return method !== 'browser-high' && method !== 'browser-pixelated';
}

/**
 * `stretch` distorts to exactly width × height.
 * `contain` preserves aspect ratio, centre-cropping the source region.
 */
export type FitMethod = 'stretch' | 'contain';

export interface ResizeState {
  /** When false the whole resize step is skipped and the source passes through. */
  enabled: boolean;
  /** Target width in px, ≥ 1. Seeded from the decoded source on load. */
  width: number;
  /** Target height in px, ≥ 1. Seeded from the decoded source on load. */
  height: number;
  method: ResizeMethod;
  /** Multiply RGB by alpha before resampling — avoids halos on transparency. */
  premultiply: boolean;
  /** Resample in linear light rather than sRGB — more accurate, slightly slower. */
  linearRGB: boolean;
  fitMethod: FitMethod;
}

/** {@link ResizeState} minus the on/off switch — what the resizer actually needs. */
export type ResizeOptions = Omit<ResizeState, 'enabled'>;

/** {@link ResizeOptions} restricted to methods the worker can execute. */
export type WorkerResizeOptions = Omit<ResizeOptions, 'method'> & {
  method: WorkerResizeMethod;
};

/* -------------------------------------------------------------------------- */
/* Processor / preprocessor state                                              */
/* -------------------------------------------------------------------------- */

/** Per-side transforms applied after preprocessing and before encoding. */
export interface ProcessorState {
  resize: ResizeState;
}

/** Clockwise rotation in degrees. */
export type RotateAngle = 0 | 90 | 180 | 270;

export const ROTATE_ANGLES: readonly RotateAngle[] = [0, 90, 180, 270];

/** Crop rectangle in source pixels, applied after rotation. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Transforms applied to the source once, shared by both sides.
 * Changing this invalidates the decode-side cache for *both* sides.
 */
export interface PreprocessorState {
  rotate: RotateAngle;
  /** Absent ⇒ no crop. */
  crop?: CropRect;
}

/* -------------------------------------------------------------------------- */
/* Side settings                                                               */
/* -------------------------------------------------------------------------- */

/** Everything one editor side needs, for one specific encoder. */
export interface SideSettingsFor<K extends EncoderId = EncoderId> {
  encoderId: K;
  encoderOptions: EncoderOptionsMap[K];
  processorState: ProcessorState;
}

/**
 * Discriminated union over `encoderId` — narrowing on `encoderId` narrows
 * `encoderOptions` too:
 *
 * ```ts
 * if (settings.encoderId === 'mozjpeg') settings.encoderOptions.quality; // ok
 * ```
 *
 * Build new values with {@link createSideSettings} / {@link withEncoder} rather
 * than mutating `encoderId` in place.
 */
export type SideSettings = { [K in EncoderId]: SideSettingsFor<K> }[EncoderId];

/** Type guard for narrowing a `SideSettings` to one encoder. */
export function isSideSettingsFor<K extends EncoderId>(
  settings: SideSettings,
  id: K,
): settings is Extract<SideSettings, { encoderId: K }> {
  return settings.encoderId === id;
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Treat every exported default as immutable — call the matching `create*`
 * factory when you need a value to hand to `$state`.
 */
export const defaultResizeState: ResizeState = {
  enabled: false,
  width: 1,
  height: 1,
  method: 'lanczos3',
  premultiply: true,
  linearRGB: true,
  fitMethod: 'stretch',
};

export const defaultProcessorState: ProcessorState = {
  resize: defaultResizeState,
};

export const defaultPreprocessorState: PreprocessorState = {
  rotate: 0,
};

export function createDefaultResizeState(): ResizeState {
  return { ...defaultResizeState };
}

export function createDefaultProcessorState(): ProcessorState {
  return { resize: createDefaultResizeState() };
}

export function createDefaultPreprocessorState(): PreprocessorState {
  return { rotate: 0 };
}

/** Build a fresh `SideSettings` for `id`, defaulting anything not supplied. */
export function createSideSettings<K extends EncoderId>(
  encoderId: K,
  encoderOptions?: Partial<EncoderOptionsMap[K]>,
  processorState?: ProcessorState,
): SideSettingsFor<K> {
  return {
    encoderId,
    encoderOptions: { ...DEFAULT_ENCODER_OPTIONS[encoderId], ...encoderOptions },
    processorState: processorState
      ? cloneProcessorState(processorState)
      : createDefaultProcessorState(),
  };
}

/** Swap the encoder while keeping the processor state (resize) intact. */
export function withEncoder<K extends EncoderId>(
  settings: SideSettings,
  encoderId: K,
  encoderOptions?: Partial<EncoderOptionsMap[K]>,
): SideSettingsFor<K> {
  return createSideSettings(encoderId, encoderOptions, settings.processorState);
}

/**
 * Side 0 is the untouched reference, side 1 is the compressed candidate —
 * the same split Squoosh ships with.
 */
export function createDefaultSideSettings(side: 0 | 1): SideSettings {
  return side === 0 ? createSideSettings('identity') : createSideSettings('mozjpeg');
}

export function cloneProcessorState(state: ProcessorState): ProcessorState {
  return { resize: { ...state.resize } };
}

export function clonePreprocessorState(state: PreprocessorState): PreprocessorState {
  return state.crop ? { rotate: state.rotate, crop: { ...state.crop } } : { rotate: state.rotate };
}

export function cloneSideSettings(settings: SideSettings): SideSettings {
  return {
    encoderId: settings.encoderId,
    encoderOptions: { ...settings.encoderOptions },
    processorState: cloneProcessorState(settings.processorState),
  } as SideSettings;
}

/* -------------------------------------------------------------------------- */
/* Equality helpers (used by the job engine and the result cache)              */
/* -------------------------------------------------------------------------- */

/** One-level-deep structural equality for plain objects. */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const aKeys = Object.keys(aRec);
  if (aKeys.length !== Object.keys(bRec).length) return false;

  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bRec, key)) return false;
    if (aRec[key] !== bRec[key]) return false;
  }
  return true;
}

/**
 * Two resize configs are equivalent when both are disabled, regardless of the
 * width/height/method values sitting behind the switch. Prevents pointless
 * re-encodes when the user fiddles with a disabled panel.
 */
export function resizeStateEqual(a: ResizeState, b: ResizeState): boolean {
  if (a === b) return true;
  if (!a.enabled && !b.enabled) return true;
  return shallowEqual(a, b);
}

export function processorStateEqual(a: ProcessorState, b: ProcessorState): boolean {
  return a === b || resizeStateEqual(a.resize, b.resize);
}

export function cropRectEqual(a: CropRect | undefined, b: CropRect | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function preprocessorStateEqual(a: PreprocessorState, b: PreprocessorState): boolean {
  return a === b || (a.rotate === b.rotate && cropRectEqual(a.crop, b.crop));
}

export function sideSettingsEqual(a: SideSettings, b: SideSettings): boolean {
  if (a === b) return true;
  if (a.encoderId !== b.encoderId) return false;
  if (!shallowEqual(a.encoderOptions, b.encoderOptions)) return false;
  return processorStateEqual(a.processorState, b.processorState);
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Source rectangle to sample when `fitMethod` is `'contain'`: the largest
 * centred region of the source matching the target aspect ratio.
 * For `'stretch'` the full source is used.
 */
export function getContainOffsets(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = targetWidth / targetHeight;

  if (sourceAspect > targetAspect) {
    const sw = sourceHeight * targetAspect;
    return { sx: (sourceWidth - sw) / 2, sy: 0, sw, sh: sourceHeight };
  }
  const sh = sourceWidth / targetAspect;
  return { sx: 0, sy: (sourceHeight - sh) / 2, sw: sourceWidth, sh };
}

/** Height that keeps the source aspect ratio for a given target `width`. */
export function heightForWidth(
  sourceWidth: number,
  sourceHeight: number,
  width: number,
): number {
  if (sourceWidth <= 0) return 1;
  return Math.max(1, Math.round((width * sourceHeight) / sourceWidth));
}

/** Width that keeps the source aspect ratio for a given target `height`. */
export function widthForHeight(
  sourceWidth: number,
  sourceHeight: number,
  height: number,
): number {
  if (sourceHeight <= 0) return 1;
  return Math.max(1, Math.round((height * sourceWidth) / sourceHeight));
}
