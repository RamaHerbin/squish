/**
 * Encoder identity, per-codec option shapes, and the encoder registry contract.
 *
 * Option interfaces mirror the real `@jsquash/*` types 1:1 (field names and
 * casing included) so a value of type `EncoderOptionsMap[K]` can be handed
 * straight to the matching jSquash `encode()` call.
 *
 * Dependency-free: types and tiny pure helpers only.
 */

import type { ImageMimeType } from './image';

/* -------------------------------------------------------------------------- */
/* Encoder identity                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every output an editor side can produce.
 *
 * - wasm codecs run in a worker (`WorkerEncoderId`)
 * - `browser-*` use `canvas.convertToBlob` / `toBlob` and stay on the main thread
 * - `identity` means "no re-encode": the original file is passed through, used
 *   for the left-hand reference side.
 */
export type EncoderId =
  | 'avif'
  | 'jxl'
  | 'webp'
  | 'mozjpeg'
  | 'oxipng'
  | 'qoi'
  | 'browser-png'
  | 'browser-jpeg'
  | 'browser-webp'
  | 'identity';

/** Encoders backed by wasm; only these are reachable through the worker. */
export type WorkerEncoderId = 'avif' | 'jxl' | 'webp' | 'mozjpeg' | 'oxipng' | 'qoi';

/** Encoders backed by the browser's own canvas encoders. */
export type BrowserEncoderId = 'browser-png' | 'browser-jpeg' | 'browser-webp';

/** Display order used by the encoder `<select>`. */
export const ENCODER_IDS: readonly EncoderId[] = [
  'identity',
  'mozjpeg',
  'oxipng',
  'webp',
  'avif',
  'jxl',
  'qoi',
  'browser-jpeg',
  'browser-png',
  'browser-webp',
];

export const WORKER_ENCODER_IDS: readonly WorkerEncoderId[] = [
  'avif',
  'jxl',
  'webp',
  'mozjpeg',
  'oxipng',
  'qoi',
];

export function isEncoderId(value: unknown): value is EncoderId {
  return typeof value === 'string' && (ENCODER_IDS as readonly string[]).includes(value);
}

export function isWorkerEncoderId(value: unknown): value is WorkerEncoderId {
  return (
    typeof value === 'string' && (WORKER_ENCODER_IDS as readonly string[]).includes(value)
  );
}

/* -------------------------------------------------------------------------- */
/* Per-codec options                                                           */
/* -------------------------------------------------------------------------- */

/** Encoders with nothing to tune (`qoi`, `browser-png`, `identity`). */
export type NoOptions = Record<string, never>;

/** `AVIFTune` from `@jsquash/avif` — declared as literals to dodge `const enum`. */
export type AvifTune = 0 | 1 | 2;
export const AvifTune = { auto: 0, psnr: 1, ssim: 2 } as const;

/** 0 = YUV400 (greyscale), 1 = YUV420, 2 = YUV422, 3 = YUV444. */
export type AvifSubsample = 0 | 1 | 2 | 3;

/** Mirrors `@jsquash/avif` `EncodeOptions` (raw options + `lossless`). */
export interface AvifEncodeOptions {
  /** 0–100, higher is better quality. */
  quality: number;
  /** 0–100, or `-1` to reuse {@link AvifEncodeOptions.quality}. */
  qualityAlpha: number;
  /** 0–50. */
  denoiseLevel: number;
  /** 0–6. */
  tileRowsLog2: number;
  /** 0–6. */
  tileColsLog2: number;
  /** 0 (slowest/best) – 10 (fastest). */
  speed: number;
  subsample: AvifSubsample;
  chromaDeltaQ: boolean;
  /** 0–7. */
  sharpness: number;
  enableSharpYUV: boolean;
  tune: AvifTune;
  /** jSquash supports 8 | 10 | 12; squish only ships the 8-bit path. */
  bitDepth: 8;
  lossless: boolean;
}

/** Mirrors `@jsquash/jxl` `EncodeOptions`. */
export interface JxlEncodeOptions {
  /** 1 (fastest) – 9 (slowest/best). */
  effort: number;
  /** 0–100, higher is better quality. */
  quality: number;
  progressive: boolean;
  /** Edge-preserving filter, `-1` = auto, otherwise 0–3. */
  epf: number;
  lossyPalette: boolean;
  /** 0–4. */
  decodingSpeedTier: number;
  /** Synthetic grain, ISO value. 0 disables. */
  photonNoiseIso: number;
  lossyModular: boolean;
  lossless: boolean;
}

/** Mirrors `@jsquash/webp` `EncodeOptions` (libwebp `WebPConfig`, all numeric). */
export interface WebpEncodeOptions {
  /** 0–100. */
  quality: number;
  target_size: number;
  target_PSNR: number;
  /** 0 (fast) – 6 (slow). */
  method: number;
  sns_strength: number;
  filter_strength: number;
  filter_sharpness: number;
  filter_type: number;
  partitions: number;
  segments: number;
  pass: number;
  show_compressed: number;
  preprocessing: number;
  autofilter: number;
  partition_limit: number;
  alpha_compression: number;
  alpha_filtering: number;
  alpha_quality: number;
  /** 0 | 1 — libwebp uses ints, not booleans. */
  lossless: number;
  exact: number;
  image_hint: number;
  emulate_jpeg_size: number;
  thread_level: number;
  low_memory: number;
  near_lossless: number;
  use_delta_palette: number;
  use_sharp_yuv: number;
}

/** `MozJpegColorSpace` from `@jsquash/jpeg`. */
export type MozJpegColorSpace = 1 | 2 | 3;
export const MozJpegColorSpace = { GRAYSCALE: 1, RGB: 2, YCbCr: 3 } as const;

/** Mirrors `@jsquash/jpeg` `EncodeOptions` — snake_case is intentional. */
export interface MozJpegEncodeOptions {
  /** 0–100. */
  quality: number;
  baseline: boolean;
  arithmetic: boolean;
  progressive: boolean;
  optimize_coding: boolean;
  /** 0–100. */
  smoothing: number;
  color_space: MozJpegColorSpace;
  /** 0–8, quantisation table preset. */
  quant_table: number;
  trellis_multipass: boolean;
  trellis_opt_zero: boolean;
  trellis_opt_table: boolean;
  trellis_loops: number;
  auto_subsample: boolean;
  /** 1–4, ignored when `auto_subsample` is true. */
  chroma_subsample: number;
  separate_chroma_quality: boolean;
  /** 0–100, ignored unless `separate_chroma_quality` is true. */
  chroma_quality: number;
}

/** Mirrors `@jsquash/oxipng` `OptimiseOptions`. */
export interface OxiPngEncodeOptions {
  /** 0–6, higher tries harder. */
  level: number;
  interlace: boolean;
  optimiseAlpha: boolean;
}

/** Options for the canvas-backed `browser-jpeg` / `browser-webp` encoders. */
export interface BrowserQualityOptions {
  /** 0–1, matching the `canvas.toBlob(type, quality)` argument. */
  quality: number;
}

/** Exhaustive map from encoder id to its option shape. */
export interface EncoderOptionsMap {
  avif: AvifEncodeOptions;
  jxl: JxlEncodeOptions;
  webp: WebpEncodeOptions;
  mozjpeg: MozJpegEncodeOptions;
  oxipng: OxiPngEncodeOptions;
  qoi: NoOptions;
  'browser-png': NoOptions;
  'browser-jpeg': BrowserQualityOptions;
  'browser-webp': BrowserQualityOptions;
  identity: NoOptions;
}

/** Union of every option shape. Prefer `EncoderOptionsMap[K]` when `K` is known. */
export type AnyEncoderOptions = EncoderOptionsMap[EncoderId];

/** Options paired with the encoder they belong to, for one specific encoder. */
export interface EncoderStateFor<K extends EncoderId = EncoderId> {
  encoderId: K;
  options: EncoderOptionsMap[K];
}

/** Discriminated union over `encoderId`; narrows `options` automatically. */
export type EncoderState = { [K in EncoderId]: EncoderStateFor<K> }[EncoderId];

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Default options per encoder, copied verbatim from the installed
 * `@jsquash/*` `meta.js` files (browser encoders use 0.75, matching Squoosh).
 *
 * Treat as immutable — always spread before mutating:
 * `{ ...DEFAULT_ENCODER_OPTIONS.mozjpeg, quality: 90 }`.
 */
export const DEFAULT_ENCODER_OPTIONS: { readonly [K in EncoderId]: EncoderOptionsMap[K] } = {
  avif: {
    quality: 50,
    qualityAlpha: -1,
    denoiseLevel: 0,
    tileColsLog2: 0,
    tileRowsLog2: 0,
    speed: 6,
    subsample: 1,
    chromaDeltaQ: false,
    sharpness: 0,
    tune: 0,
    enableSharpYUV: false,
    bitDepth: 8,
    lossless: false,
  },
  jxl: {
    effort: 7,
    quality: 75,
    progressive: false,
    epf: -1,
    lossyPalette: false,
    decodingSpeedTier: 0,
    photonNoiseIso: 0,
    lossyModular: false,
    lossless: false,
  },
  webp: {
    quality: 75,
    target_size: 0,
    target_PSNR: 0,
    method: 4,
    sns_strength: 50,
    filter_strength: 60,
    filter_sharpness: 0,
    filter_type: 1,
    partitions: 0,
    segments: 4,
    pass: 1,
    show_compressed: 0,
    preprocessing: 0,
    autofilter: 0,
    partition_limit: 0,
    alpha_compression: 1,
    alpha_filtering: 1,
    alpha_quality: 100,
    lossless: 0,
    exact: 0,
    image_hint: 0,
    emulate_jpeg_size: 0,
    thread_level: 0,
    low_memory: 0,
    near_lossless: 100,
    use_delta_palette: 0,
    use_sharp_yuv: 0,
  },
  mozjpeg: {
    quality: 75,
    baseline: false,
    arithmetic: false,
    progressive: true,
    optimize_coding: true,
    smoothing: 0,
    color_space: 3,
    quant_table: 3,
    trellis_multipass: false,
    trellis_opt_zero: false,
    trellis_opt_table: false,
    trellis_loops: 1,
    auto_subsample: true,
    chroma_subsample: 2,
    separate_chroma_quality: false,
    chroma_quality: 75,
  },
  oxipng: { level: 2, interlace: false, optimiseAlpha: false },
  qoi: {},
  'browser-png': {},
  'browser-jpeg': { quality: 0.75 },
  'browser-webp': { quality: 0.75 },
  identity: {},
};

/** Fresh, mutable copy of an encoder's defaults. Safe to hand to `$state`. */
export function defaultOptionsFor<K extends EncoderId>(id: K): EncoderOptionsMap[K] {
  return { ...DEFAULT_ENCODER_OPTIONS[id] };
}

/**
 * Slider bounds for the primary "quality" control of each encoder that has one.
 * Absent key ⇒ the encoder exposes no quality slider.
 */
export const ENCODER_QUALITY_RANGE: Readonly<
  Partial<Record<EncoderId, { min: number; max: number; step: number }>>
> = {
  avif: { min: 0, max: 100, step: 1 },
  jxl: { min: 0, max: 100, step: 0.1 },
  webp: { min: 0, max: 100, step: 1 },
  mozjpeg: { min: 0, max: 100, step: 1 },
  'browser-jpeg': { min: 0, max: 1, step: 0.01 },
  'browser-webp': { min: 0, max: 1, step: 0.01 },
};

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * MIME type an encoder emits. `identity` reports `''` because its output type
 * is whatever the source file already was.
 */
export type OutputMimeType = ImageMimeType | '';

export interface EncoderMeta<K extends EncoderId = EncoderId> {
  readonly id: K;
  /** Human label for the encoder `<select>`, e.g. `"MozJPEG"`. */
  readonly label: string;
  /** `''` for `identity` only. */
  readonly mimeType: OutputMimeType;
  /** File extension without a dot, e.g. `"jpg"`. `''` for `identity`. */
  readonly extension: string;
  readonly defaultOptions: EncoderOptionsMap[K];
  /** True when the encoder discards information at its default settings. */
  readonly lossy: boolean;
  readonly supportsAlpha: boolean;
  /** True when encoding is dispatched to the worker rather than canvas. */
  readonly usesWorker: boolean;
}

/**
 * A lazily-imported encoder implementation.
 *
 * `encode` receives the AbortSignal first, mirroring Squoosh's worker bridge.
 * Implementations must reject with an `AbortError` `DOMException` when the
 * signal fires (see `assertSignal` / `abortable` in `jobs.ts`).
 */
export interface EncoderModule<K extends EncoderId = EncoderId> {
  readonly meta: EncoderMeta<K>;
  encode(
    signal: AbortSignal,
    data: ImageData,
    options: EncoderOptionsMap[K],
  ): Promise<ArrayBuffer>;
  /**
   * Runtime capability probe (wasm feature detect, `canvas.toBlob` type
   * support…). Absent ⇒ always available. Results should be memoised by the
   * implementation; the UI calls this to grey out unsupported encoders.
   */
  featureTest?(): Promise<boolean>;
}

/** Static, synchronously-available metadata for every encoder. */
export type EncoderRegistry = { readonly [K in EncoderId]: EncoderMeta<K> };

/**
 * Lazy loader for encoder implementations — one dynamic `import()` per codec so
 * wasm payloads are only fetched when an encoder is actually selected.
 * Implementations must cache the returned promise per id.
 */
export type LoadEncoderModule = <K extends EncoderId>(id: K) => Promise<EncoderModule<K>>;

/* -------------------------------------------------------------------------- */
/* Decoding                                                                    */
/* -------------------------------------------------------------------------- */

export interface DecodeResult {
  /** Full-size RGBA pixels. */
  data: ImageData;
  /** The type actually decoded, as determined by sniffing. `''` if unknown. */
  mimeType: OutputMimeType;
  /** Present only for SVG sources; enables vector-quality resizing. */
  vector?: { svgText: string };
  /** True when the browser decoded it natively rather than via wasm. */
  usedBuiltinDecoder: boolean;
  /** Present when the source was HDR (pixels above are tone-mapped SDR). */
  hdr?: import('./image').HdrInfo;
}
