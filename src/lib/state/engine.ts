/**
 * The orchestration half of the job engine: work diffing plus the four pipeline
 * steps (decode → preprocess → process → encode). Everything here is pure or
 * dependency-injected, so `vitest` can drive the whole pipeline with a fake
 * bridge and no DOM. The reactive half lives in `session.svelte.ts`.
 *
 * ## Why the split
 * `updateImage()` in Squoosh is one 300-line method because it must never be
 * *partially* applied — it inspects the whole desired state, decides what can be
 * skipped, and only then starts work. That decision is pure: it is
 * {@link planWork} here, and it is unit-testable without a single pixel.
 *
 * ## Transfer discipline
 * The engine hands the bridge `ImageData` it still owns afterwards (the decoded
 * source, the cached `preprocessed`, the reusable `processed`). Per
 * `contracts/worker.ts`, a bridge that transfers must `cloneTransferable` the
 * inbound payload first — the engine deliberately does **not** pre-copy, because
 * a defensive clone here plus a clone in the bridge means two full-image copies
 * per encode. {@link assertNotDetached} turns a misbehaving bridge into a loud,
 * immediate error instead of a mystifying zero-length image three steps later.
 *
 * The one exception is `WorkerApi.decode`, whose compressed `ArrayBuffer` is
 * transfer-and-consume: {@link decodeBitmap} reads the bytes fresh per attempt
 * and never reuses a buffer it has already handed over.
 */

import {
  EXTENSION_BY_MIME,
  MIME_SNIFF_BYTES,
  PDF_NOT_AN_IMAGE_MESSAGE,
  abortable,
  assertSignal,
  createDefaultProcessorState,
  getContainOffsets,
  isAbortError,
  isVectorMimeType,
  isWorkerDecodableMimeType,
  isWorkerFailure,
  isWorkerResizeMethod,
  mimeTypeFromFilename,
  preprocessorStateEqual,
  processorStateEqual,
  replaceExtension,
  shallowEqual,
  sniffMimeTypeFromBytes,
} from '../contracts';
import type {
  BrowserEncoderId,
  CropRect,
  EncoderId,
  EncoderOptionsMap,
  EncoderRegistry,
  ImageMimeType,
  OutputMimeType,
  PreprocessorState,
  ProcessorState,
  ResizeOptions,
  ResizeState,
  SideSettings,
  SourceImage,
  VectorSource,
  WorkerBridgeApi,
  WorkerResizeOptions,
} from '../contracts';
import { toSrgb } from '../codecs/canvas';

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Thrown at a side when the shared source it depends on failed or vanished.
 * The engine reports the failure once, on the source, rather than twice more on
 * each side.
 */
export class SourceUnavailableError extends Error {
  override readonly name = 'SourceUnavailableError';
  constructor(message = 'No source image available', options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Normalise anything thrown into an `Error` with a useful message. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : String(value));
}

/* -------------------------------------------------------------------------- */
/* Work planning                                                               */
/* -------------------------------------------------------------------------- */

/** Shared work: which file, transformed how. Invalidates both sides. */
export interface MainJob {
  file: File;
  preprocessorState: PreprocessorState;
}

/** Per-side work: one settings snapshot. */
export interface SideJob {
  settings: SideSettings;
}

export interface SideWork {
  processing: boolean;
  /** `processing` implies `encoding`; the reverse is not true. */
  encoding: boolean;
}

export interface WorkPlan {
  /** False ⇒ the current results already describe the desired state. */
  needed: boolean;
  decoding: boolean;
  preprocessing: boolean;
  sides: [SideWork, SideWork];
}

export interface JobSnapshot {
  main: Partial<MainJob>;
  sides: [SideJob | undefined, SideJob | undefined];
}

export interface DesiredJobs {
  main: MainJob;
  sides: [SideJob, SideJob];
}

/** Frozen "no processing at all", used for the `identity` pass-through side. */
const IDENTITY_PROCESSOR_STATE: ProcessorState = createDefaultProcessorState();

/**
 * `identity` means "hand back the original file", so per-side processing is
 * meaningless for it — Squoosh does the same substitution. Comparing effective
 * states is what stops a stale resize on a since-abandoned encoder from forcing
 * pointless work.
 */
export function effectiveProcessorState(settings: SideSettings): ProcessorState {
  return settings.encoderId === 'identity' ? IDENTITY_PROCESSOR_STATE : settings.processorState;
}

function sideWorkFor(
  preprocessing: boolean,
  current: SideJob | undefined,
  desired: SideJob,
): SideWork {
  if (!current) return { processing: true, encoding: true };

  const latest = current.settings;
  const next = desired.settings;
  const processing =
    preprocessing ||
    // Crossing the identity boundary changes what "processed" even means.
    (latest.encoderId === 'identity') !== (next.encoderId === 'identity') ||
    !processorStateEqual(effectiveProcessorState(latest), effectiveProcessorState(next));

  const encoding =
    processing ||
    latest.encoderId !== next.encoderId ||
    !shallowEqual(latest.encoderOptions, next.encoderOptions);

  return { processing, encoding };
}

/**
 * Diff "what produced the pixels on screen (or what is already in flight)"
 * against "what the UI is asking for", and report the cheapest sufficient work.
 *
 * `current` must describe the *in-flight* job when there is one — otherwise a
 * second call while an encode is running would restart it forever.
 */
export function planWork(current: JobSnapshot, desired: DesiredJobs): WorkPlan {
  const decoding = current.main.file !== desired.main.file;
  const preprocessing =
    decoding ||
    !current.main.preprocessorState ||
    !preprocessorStateEqual(current.main.preprocessorState, desired.main.preprocessorState);

  const sides: [SideWork, SideWork] = [
    sideWorkFor(preprocessing, current.sides[0], desired.sides[0]),
    sideWorkFor(preprocessing, current.sides[1], desired.sides[1]),
  ];

  const needed =
    decoding ||
    preprocessing ||
    sides[0].processing ||
    sides[0].encoding ||
    sides[1].processing ||
    sides[1].encoding;

  return { needed, decoding, preprocessing, sides };
}

/* -------------------------------------------------------------------------- */
/* Injected platform hooks                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Everything the pipeline needs that is neither the worker bridge nor pure
 * logic. Defaults ({@link createDefaultEngineHooks}) are browser
 * implementations; the codec layer can override any of them, and tests can
 * replace the lot.
 */
export interface EngineHooks {
  /** Sniff, decode, and (for SVG) retain the markup for vector re-rasterising. */
  decodeSource(signal: AbortSignal, file: File, bridge: WorkerBridgeApi): Promise<SourceImage>;
  /** Round-trip an encoded result back to pixels for the preview canvas. */
  decodeOutput(signal: AbortSignal, file: File, bridge: WorkerBridgeApi): Promise<ImageData>;
  /** `canvas.convertToBlob` / `toBlob` encoders, which cannot leave the main thread. */
  encodeBrowser<K extends BrowserEncoderId>(
    signal: AbortSignal,
    id: K,
    data: ImageData,
    options: EncoderOptionsMap[K],
  ): Promise<ArrayBuffer>;
  /** `browser-high` / `browser-pixelated` resizing, plus SVG re-rasterising. */
  resizeOnMainThread(
    signal: AbortSignal,
    data: ImageData,
    options: ResizeOptions,
    vector?: VectorSource,
  ): Promise<ImageData>;
  /** Crop is a pure pixel copy; there is no worker round-trip worth paying for. */
  crop(signal: AbortSignal, data: ImageData, rect: CropRect): Promise<ImageData>;
}

/** Persistence seam so the session can write settings without importing IndexedDB. */
export interface SettingsPersistence {
  /** Fire-and-forget; implementations debounce and swallow their own errors. */
  save(side: 0 | 1, settings: SideSettings): void;
}

/* -------------------------------------------------------------------------- */
/* Encoder output metadata                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Output MIME per encoder. A local table rather than a codec-layer import, so
 * the engine stays dependency-free; pass an {@link EncoderRegistry} to
 * {@link outputFor} to have the real registry win.
 */
export const ENCODER_OUTPUT_MIME: Readonly<Record<EncoderId, OutputMimeType>> = {
  avif: 'image/avif',
  jxl: 'image/jxl',
  webp: 'image/webp',
  mozjpeg: 'image/jpeg',
  oxipng: 'image/png',
  qoi: 'image/qoi',
  'browser-png': 'image/png',
  'browser-jpeg': 'image/jpeg',
  'browser-webp': 'image/webp',
  // Whatever the source was.
  identity: '',
};

export function outputFor(
  id: EncoderId,
  registry?: EncoderRegistry,
): { mimeType: OutputMimeType; extension: string } {
  const meta = registry?.[id];
  if (meta) return { mimeType: meta.mimeType, extension: meta.extension };
  const mimeType = ENCODER_OUTPUT_MIME[id];
  return { mimeType, extension: mimeType ? EXTENSION_BY_MIME[mimeType] : '' };
}

/** `photo.png` + mozjpeg → `photo.jpg`. `identity` keeps the original name. */
export function outputFileName(
  sourceName: string,
  id: EncoderId,
  registry?: EncoderRegistry,
): string {
  const { extension } = outputFor(id, registry);
  return extension ? replaceExtension(sourceName, extension) : sourceName;
}

/* -------------------------------------------------------------------------- */
/* Pixel helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Construct `ImageData` where it exists, and a structurally identical plain
 * object where it does not (node, i.e. vitest). Nothing in the engine reads
 * anything but `data` / `width` / `height`.
 */
export function createImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  colorSpace: PredefinedColorSpace = 'srgb',
): ImageData {
  if (typeof ImageData === 'function') {
    const Ctor = ImageData as unknown as new (
      data: Uint8ClampedArray,
      width: number,
      height: number,
      settings?: ImageDataSettings,
    ) => ImageData;
    return new Ctor(data, width, height, { colorSpace });
  }
  return { data, width, height, colorSpace } as unknown as ImageData;
}

export function cloneImageData(image: ImageData): ImageData {
  return createImageData(
    new Uint8ClampedArray(image.data),
    image.width,
    image.height,
    image.colorSpace ?? 'srgb',
  );
}

/**
 * Guard against a bridge that transfers pixels it was only lent. Transferring
 * detaches the buffer, so `byteLength` collapses to 0 and every later use of
 * that `ImageData` silently produces a black image — this makes it fail here
 * instead, naming the culprit.
 */
export function assertNotDetached(image: ImageData, context: string): void {
  const buffer = image.data.buffer as ArrayBuffer;
  if (buffer.byteLength === 0 && image.width * image.height > 0) {
    throw new Error(
      `${context}: the worker bridge detached an ImageData buffer the engine still owns. ` +
        'Bridges must cloneTransferable() inbound pixels before transferring them.',
    );
  }
}

function clampDimension(value: number): number {
  return Math.max(1, Math.round(Number.isFinite(value) ? value : 1));
}

/* -------------------------------------------------------------------------- */
/* Resize helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Strip the on/off switch, and make the target dimensions safe for wasm. */
export function resizeOptionsFrom(resize: ResizeState): ResizeOptions {
  return {
    width: clampDimension(resize.width),
    height: clampDimension(resize.height),
    method: resize.method,
    premultiply: resize.premultiply,
    linearRGB: resize.linearRGB,
    fitMethod: resize.fitMethod,
  };
}

/** Seed a resize panel from freshly decoded dimensions, switch off. */
export function seedResizeState(resize: ResizeState, width: number, height: number): void {
  resize.width = clampDimension(width);
  resize.height = clampDimension(height);
  resize.enabled = false;
}

/** 90°/270° rotation: the user's target dimensions must follow the image round. */
export function swapResizeDimensions(resize: ResizeState): void {
  const { width, height } = resize;
  resize.width = height;
  resize.height = width;
}

/* -------------------------------------------------------------------------- */
/* Pipeline                                                                    */
/* -------------------------------------------------------------------------- */

/** decode: File → pixels. */
export async function runDecode(
  signal: AbortSignal,
  file: File,
  bridge: WorkerBridgeApi,
  hooks: EngineHooks,
): Promise<SourceImage> {
  assertSignal(signal);
  return abortable(signal, hooks.decodeSource(signal, file, bridge));
}

/**
 * preprocess: rotate then crop, shared by both sides.
 *
 * Returns the *same reference* when there is nothing to do. That matters: the
 * result cache keys on the identity of these pixels, so a no-op preprocess must
 * not mint a new object and blow the cache away.
 */
export async function runPreprocess(
  signal: AbortSignal,
  decoded: ImageData,
  state: PreprocessorState,
  bridge: WorkerBridgeApi,
  hooks: EngineHooks,
): Promise<ImageData> {
  assertSignal(signal);
  let result = decoded;

  if (state.rotate !== 0) {
    result = await abortable(signal, bridge.rotate(signal, result, state.rotate));
    assertNotDetached(decoded, 'rotate');
  }

  if (state.crop) {
    const before = result;
    result = await abortable(signal, hooks.crop(signal, result, state.crop));
    assertNotDetached(before, 'crop');
  }

  return result;
}

/**
 * process: per-side resize. Returns the input reference when disabled or when
 * the target size already matches, for the same cache-identity reason as above.
 */
export async function runProcess(
  signal: AbortSignal,
  preprocessed: ImageData,
  processorState: ProcessorState,
  bridge: WorkerBridgeApi,
  hooks: EngineHooks,
  vector?: VectorSource,
): Promise<ImageData> {
  assertSignal(signal);
  if (!processorState.resize.enabled) return preprocessed;

  const options = resizeOptionsFrom(processorState.resize);
  const sameSize = options.width === preprocessed.width && options.height === preprocessed.height;
  // A vector source is worth re-rasterising even at the same size only if the
  // caller asked for a browser method; otherwise same-size is a no-op.
  if (sameSize && !(vector && !isWorkerResizeMethod(options.method))) return preprocessed;

  if (isWorkerResizeMethod(options.method)) {
    const workerOptions: WorkerResizeOptions = { ...options, method: options.method };
    const result = await abortable(signal, bridge.resize(signal, preprocessed, workerOptions));
    assertNotDetached(preprocessed, 'resize');
    return result;
  }

  const result = await abortable(
    signal,
    hooks.resizeOnMainThread(signal, preprocessed, options, vector),
  );
  assertNotDetached(preprocessed, 'resize');
  return result;
}

/**
 * The exhaustive encoder switch. Written as a `switch` rather than a lookup so
 * TypeScript narrows `settings.encoderOptions` alongside `settings.encoderId` —
 * the whole point of `SideSettings` being a discriminated union. Adding an
 * encoder to the contract makes this fail to compile, which is intended.
 */
async function encodeBytes(
  signal: AbortSignal,
  image: ImageData,
  settings: SideSettings,
  bridge: WorkerBridgeApi,
  hooks: EngineHooks,
): Promise<ArrayBuffer> {
  switch (settings.encoderId) {
    case 'avif':
      return bridge.encode(signal, 'avif', image, settings.encoderOptions);
    case 'jxl':
      return bridge.encode(signal, 'jxl', image, settings.encoderOptions);
    case 'webp':
      return bridge.encode(signal, 'webp', image, settings.encoderOptions);
    case 'mozjpeg':
      return bridge.encode(signal, 'mozjpeg', image, settings.encoderOptions);
    case 'oxipng':
      return bridge.encode(signal, 'oxipng', image, settings.encoderOptions);
    case 'qoi':
      return bridge.encode(signal, 'qoi', image, settings.encoderOptions);
    case 'browser-png':
      return hooks.encodeBrowser(signal, 'browser-png', image, settings.encoderOptions);
    case 'browser-jpeg':
      return hooks.encodeBrowser(signal, 'browser-jpeg', image, settings.encoderOptions);
    case 'browser-webp':
      return hooks.encodeBrowser(signal, 'browser-webp', image, settings.encoderOptions);
    case 'identity':
      throw new Error('identity is a pass-through and must not reach the encoder');
  }
}

/**
 * The canvas encoder to fall back to when a wasm codec worker fails outright —
 * never loaded, or wedged past the bridge watchdog. Only the three formats the
 * browser can natively encode have an equivalent; `avif`/`jxl`/`qoi` have none,
 * so those surface the worker error instead of silently changing format.
 *
 * Returns a pre-bound thunk so the concrete `id`↔`options` correlation is kept
 * for `hooks.encodeBrowser`'s generic. wasm quality is 0–100, canvas quality is
 * 0–1 — hence the divide.
 */
function browserFallbackFor(
  settings: SideSettings,
  hooks: EngineHooks,
): { id: BrowserEncoderId; encode: (signal: AbortSignal, image: ImageData) => Promise<ArrayBuffer> } | undefined {
  switch (settings.encoderId) {
    case 'mozjpeg':
      return {
        id: 'browser-jpeg',
        encode: (signal, image) =>
          hooks.encodeBrowser(signal, 'browser-jpeg', image, {
            quality: settings.encoderOptions.quality / 100,
          }),
      };
    case 'webp': {
      // The canvas API only encodes lossy WebP. A lossless/near-lossless request
      // has no browser equivalent, so surface the worker error rather than
      // silently shipping a lossy file under a lossless label.
      if (settings.encoderOptions.lossless === 1 || settings.encoderOptions.near_lossless < 100) {
        return undefined;
      }
      return {
        id: 'browser-webp',
        encode: (signal, image) =>
          hooks.encodeBrowser(signal, 'browser-webp', image, {
            quality: settings.encoderOptions.quality / 100,
          }),
      };
    }
    case 'oxipng':
      return {
        id: 'browser-png',
        encode: (signal, image) => hooks.encodeBrowser(signal, 'browser-png', image, {}),
      };
    default:
      return undefined;
  }
}

/**
 * encode: pixels → `File`, named after the source with the encoder's extension.
 * `identity` short-circuits to the original file — no bytes are touched.
 *
 * If the wasm codec worker fails outright (a {@link isWorkerFailure}: load
 * failure or watchdog timeout — never a user abort), and the format has a
 * canvas equivalent, this retries once on the browser encoder and reports which
 * one via `onFallback` so the UI can flag the degraded output. avif/jxl/qoi
 * have no browser encoder, so the worker error propagates.
 *
 * `allowFallback` must be `false` for probe encodes (auto-suggest, matrix): a
 * silent codec swap mid-search measures the wrong encoder and poisons the
 * binary search, so those callers want the raw worker failure instead.
 */
export async function runEncode(
  signal: AbortSignal,
  image: ImageData,
  settings: SideSettings,
  sourceFile: File,
  bridge: WorkerBridgeApi,
  hooks: EngineHooks,
  registry?: EncoderRegistry,
  onFallback?: (id: BrowserEncoderId) => void,
  allowFallback = true,
): Promise<File> {
  assertSignal(signal);
  if (settings.encoderId === 'identity') return sourceFile;

  // The 8-bit codecs assume sRGB; gamut-map a wide-gamut source down first.
  const srgb = toSrgb(image);

  let bytes: ArrayBuffer;
  try {
    bytes = await abortable(signal, encodeBytes(signal, srgb, settings, bridge, hooks));
  } catch (error) {
    // The worker sends pixels by structured clone, not transfer, so `srgb` is
    // still intact here and safe to re-encode on the canvas.
    const fallback =
      allowFallback && isWorkerFailure(error) ? browserFallbackFor(settings, hooks) : undefined;
    if (!fallback) throw error;
    bytes = await abortable(signal, fallback.encode(signal, srgb));
    onFallback?.(fallback.id);
  }
  assertNotDetached(srgb, `encode(${settings.encoderId})`);

  const { mimeType, extension } = outputFor(settings.encoderId, registry);
  const name = extension ? replaceExtension(sourceFile.name, extension) : sourceFile.name;
  return new File([bytes], name, { type: mimeType || sourceFile.type });
}

/** Decode the encoded result so the preview shows real, round-tripped pixels. */
export async function runDecodeOutput(
  signal: AbortSignal,
  file: File,
  bridge: WorkerBridgeApi,
  hooks: EngineHooks,
): Promise<ImageData> {
  assertSignal(signal);
  return abortable(signal, hooks.decodeOutput(signal, file, bridge));
}

/* -------------------------------------------------------------------------- */
/* Default hooks — browser implementations                                     */
/* -------------------------------------------------------------------------- */

function isImageMimeType(value: string): value is ImageMimeType {
  return Object.prototype.hasOwnProperty.call(EXTENSION_BY_MIME, value);
}

/** Magic numbers first, then the browser's guess, then the filename. */
export async function sniffFile(
  signal: AbortSignal,
  file: File,
): Promise<{ mimeType: ImageMimeType | ''; unsupported?: 'application/pdf' }> {
  assertSignal(signal);
  const header = new Uint8Array(
    await abortable(signal, file.slice(0, MIME_SNIFF_BYTES).arrayBuffer()),
  );
  const sniffed = sniffMimeTypeFromBytes(header);
  if (sniffed === 'application/pdf') return { mimeType: '', unsupported: 'application/pdf' };
  if (sniffed) return { mimeType: sniffed };
  if (isImageMimeType(file.type)) return { mimeType: file.type };
  return { mimeType: mimeTypeFromFilename(file.name) };
}

function hasBuiltinDecode(): boolean {
  return (
    typeof createImageBitmap === 'function' &&
    (typeof OffscreenCanvas === 'function' || typeof document !== 'undefined')
  );
}

function createCanvasContext(
  width: number,
  height: number,
  colorSpace?: PredefinedColorSpace,
): CanvasRenderingContext2D {
  const settings: CanvasRenderingContext2DSettings | undefined = colorSpace
    ? { colorSpace }
    : undefined;
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', settings);
    if (!ctx) throw new Error('Could not acquire a 2D context');
    return ctx as unknown as CanvasRenderingContext2D;
  }
  if (typeof document === 'undefined') {
    throw new Error('Canvas is unavailable in this environment');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', settings);
  if (!ctx) throw new Error('Could not acquire a 2D context');
  return ctx;
}

function drawableToImageData(
  drawable: CanvasImageSource,
  width: number,
  height: number,
): ImageData {
  const ctx = createCanvasContext(width, height);
  ctx.drawImage(drawable, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

async function builtinDecode(signal: AbortSignal, blob: Blob): Promise<ImageData> {
  assertSignal(signal);
  const bitmap = await abortable(signal, createImageBitmap(blob));
  try {
    return drawableToImageData(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/**
 * Try the fastest decoder that can plausibly work, fall back to the other one.
 *
 * JXL and QOI have no native decoder anywhere, so they go straight to wasm;
 * everything else tries the browser first (no wasm download, no worker spin-up)
 * and falls back to wasm when the browser refuses — which is how an AVIF loads
 * on a browser that predates AVIF.
 */
async function decodeBitmap(
  signal: AbortSignal,
  file: File,
  mimeType: ImageMimeType | '',
  bridge: WorkerBridgeApi,
): Promise<ImageData> {
  assertSignal(signal);
  const workerDecodable = isWorkerDecodableMimeType(mimeType);
  const workerFirst = mimeType === 'image/jxl' || mimeType === 'image/qoi';

  const attempts: Array<() => Promise<ImageData>> = [];
  // Each attempt reads its own ArrayBuffer: `decode` consumes (transfers) it.
  const viaWorker = workerDecodable
    ? async () => bridge.decode(signal, mimeType, await abortable(signal, file.arrayBuffer()))
    : undefined;
  const viaBrowser = hasBuiltinDecode() ? () => builtinDecode(signal, file) : undefined;

  if (workerFirst && viaWorker) attempts.push(viaWorker);
  if (viaBrowser) attempts.push(viaBrowser);
  if (!workerFirst && viaWorker) attempts.push(viaWorker);

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      return await abortable(signal, attempt());
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = error;
    }
  }

  const label = mimeType || 'this file';
  throw new Error(
    `Could not decode ${label}${lastError ? ` (${toError(lastError).message})` : ''}`,
  );
}

/**
 * Firefox refuses to draw an SVG without intrinsic dimensions and Chrome draws
 * it wrong, so width/height get backfilled from the viewBox before rasterising.
 * The markup is retained on the source so a later resize can re-rasterise at the
 * target size instead of upscaling a bitmap.
 */
export function normaliseSvg(svgText: string): string {
  if (typeof DOMParser === 'undefined') return svgText;
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  if (!svg) return svgText;
  if (svg.hasAttribute('width') && svg.hasAttribute('height')) return svgText;

  const viewBox = svg.getAttribute('viewBox');
  if (viewBox === null) throw new Error('SVG must have width/height or a viewBox');
  const parts = viewBox.split(/[\s,]+/);
  const width = parts[2];
  const height = parts[3];
  if (!width || !height) throw new Error('SVG viewBox is malformed');

  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  return new XMLSerializer().serializeToString(doc);
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  if (typeof Image === 'undefined') throw new Error('SVG decoding requires a browser');
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not render the SVG'));
    img.src = url;
  });
}

async function rasteriseSvg(
  signal: AbortSignal,
  svgText: string,
  width?: number,
  height?: number,
): Promise<ImageData> {
  assertSignal(signal);
  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await abortable(signal, loadImage(url));
    const w = clampDimension(width ?? (img.naturalWidth || img.width));
    const h = clampDimension(height ?? (img.naturalHeight || img.height));
    return drawableToImageData(img, w, h);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function defaultDecodeSource(
  signal: AbortSignal,
  file: File,
  bridge: WorkerBridgeApi,
): Promise<SourceImage> {
  assertSignal(signal);
  const { mimeType, unsupported } = await sniffFile(signal, file);

  if (unsupported === 'application/pdf') {
    throw new Error(PDF_NOT_AN_IMAGE_MESSAGE);
  }

  if (isVectorMimeType(mimeType)) {
    const raw = await abortable(signal, file.text());
    const svgText = normaliseSvg(raw);
    const decoded = await rasteriseSvg(signal, svgText);
    return { file, decoded, vector: { svgText } };
  }

  const decoded = await decodeBitmap(signal, file, mimeType, bridge);
  return { file, decoded };
}

export async function defaultDecodeOutput(
  signal: AbortSignal,
  file: File,
  bridge: WorkerBridgeApi,
): Promise<ImageData> {
  assertSignal(signal);
  const mimeType = isImageMimeType(file.type) ? file.type : mimeTypeFromFilename(file.name);
  return decodeBitmap(signal, file, mimeType, bridge);
}

const BROWSER_ENCODER_MIME: Readonly<Record<BrowserEncoderId, ImageMimeType>> = {
  'browser-png': 'image/png',
  'browser-jpeg': 'image/jpeg',
  'browser-webp': 'image/webp',
};

async function canvasToBlob(
  ctx: CanvasRenderingContext2D,
  type: string,
  quality: number | undefined,
): Promise<Blob> {
  const canvas = ctx.canvas as HTMLCanvasElement | OffscreenCanvas;
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(`${type} is not supported here`))),
      type,
      quality,
    );
  });
}

export async function defaultEncodeBrowser<K extends BrowserEncoderId>(
  signal: AbortSignal,
  id: K,
  data: ImageData,
  options: EncoderOptionsMap[K],
): Promise<ArrayBuffer> {
  assertSignal(signal);
  const ctx = createCanvasContext(data.width, data.height);
  ctx.putImageData(data, 0, 0);
  // `browser-png` has no options; the others carry a 0–1 quality.
  const quality = (options as { quality?: number }).quality;
  const blob = await abortable(signal, canvasToBlob(ctx, BROWSER_ENCODER_MIME[id], quality));
  return abortable(signal, blob.arrayBuffer());
}

/**
 * Canvas resizing. `premultiply` / `linearRGB` are ignored here — canvas always
 * premultiplies in sRGB and offers no say in the matter, which is exactly why
 * the wasm methods exist.
 */
export async function defaultResizeOnMainThread(
  signal: AbortSignal,
  data: ImageData,
  options: ResizeOptions,
  vector?: VectorSource,
): Promise<ImageData> {
  assertSignal(signal);
  const width = clampDimension(options.width);
  const height = clampDimension(options.height);

  // Vector sources re-rasterise instead of resampling: infinitely crisper.
  if (vector) return rasteriseSvg(signal, vector.svgText, width, height);

  // Keep the source's gamut through the resample, or a P3 source clips to sRGB.
  const colorSpace = data.colorSpace ?? 'srgb';
  const ctx = createCanvasContext(width, height, colorSpace);
  ctx.imageSmoothingEnabled = options.method !== 'browser-pixelated';
  ctx.imageSmoothingQuality = 'high';

  const bitmap = await abortable(signal, createImageBitmap(data));
  try {
    const { sx, sy, sw, sh } =
      options.fitMethod === 'contain'
        ? getContainOffsets(data.width, data.height, width, height)
        : { sx: 0, sy: 0, sw: data.width, sh: data.height };
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
  } finally {
    bitmap.close();
  }
  return ctx.getImageData(0, 0, width, height, { colorSpace });
}

/** Crop, clamped to the image. A plain row-wise copy: no canvas, no worker. */
export async function defaultCrop(
  signal: AbortSignal,
  data: ImageData,
  rect: CropRect,
): Promise<ImageData> {
  assertSignal(signal);
  const x = Math.min(Math.max(Math.round(rect.x), 0), Math.max(data.width - 1, 0));
  const y = Math.min(Math.max(Math.round(rect.y), 0), Math.max(data.height - 1, 0));
  const width = Math.min(clampDimension(rect.width), data.width - x);
  const height = Math.min(clampDimension(rect.height), data.height - y);

  const out = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const start = ((y + row) * data.width + x) * 4;
    out.set(data.data.subarray(start, start + width * 4), row * width * 4);
  }
  return createImageData(out, width, height, data.colorSpace ?? 'srgb');
}

export function createDefaultEngineHooks(): EngineHooks {
  return {
    decodeSource: defaultDecodeSource,
    decodeOutput: defaultDecodeOutput,
    encodeBrowser: defaultEncodeBrowser,
    resizeOnMainThread: defaultResizeOnMainThread,
    crop: defaultCrop,
  };
}

/* -------------------------------------------------------------------------- */
/* Object URL helpers                                                          */
/* -------------------------------------------------------------------------- */

/** `undefined` where object URLs do not exist, rather than throwing. */
export function createObjectUrl(file: File): string | undefined {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return undefined;
  try {
    return URL.createObjectURL(file);
  } catch {
    return undefined;
  }
}

export function revokeObjectUrl(url: string | undefined): void {
  if (!url) return;
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* already gone */
  }
}
