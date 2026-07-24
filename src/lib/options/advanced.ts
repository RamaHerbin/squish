/**
 * Every tunable option of every encoder, described as data.
 *
 * This is the port of the old `panels/*.svelte` — the UI-concept ↔ real-option
 * mapping is preserved verbatim, only the rendering changed. The drawer walks
 * the columns and draws foundations primitives; it knows nothing about codecs.
 *
 * Mappings worth calling out (all inherited from Squoosh, via the panels this
 * replaces):
 *
 * - **AVIF** — "Effort" is displayed as `10 − speed`, because higher effort
 *   means slower. "Lossless" collapses quality/qualityAlpha/subsample to
 *   `100 / −1 / 4:4:4`; the last lossy quality and subsample are remembered in
 *   {@link OptionMemory} so switching back restores them instead of resetting.
 * - **JPEG XL** — "Lossless" is `quality === 100`; "Auto edge filter" is
 *   `epf === −1` with the last explicit 0–3 remembered; below quality 7 the
 *   alternative lossy (modular) mode is forced on and its checkbox locks.
 * - **WebP** — `lossless` is libwebp's 0|1 int. In lossless mode effort and
 *   quality collapse into one 0–9 preset ladder (see `knobs.ts`), "Slight
 *   loss" is `100 − near_lossless`, and "Discrete tone image" is
 *   `image_hint === 3`. "Filter sharpness" is shown inverted (`7 − raw`) since
 *   a *smaller* raw value means a *sharper* filter.
 * - **MozJPEG** — chroma controls only exist in YCbCr; `baseline` ("pointless
 *   spec compliance") swaps progressive rendering for the Huffman-table
 *   option; trellis extras only appear once multipass is on.
 *
 * Columns map 1:1 onto the comp's 4-column grid (02b).
 */

import type {
  AvifEncodeOptions,
  AvifSubsample,
  AvifTune,
  EncoderId,
  JxlEncodeOptions,
  MozJpegColorSpace as MozJpegColorSpaceValue,
  MozJpegEncodeOptions,
  OxiPngEncodeOptions,
  SideSettings,
  WebpEncodeOptions,
} from '../contracts';
import { defaultOptionsFor } from '../contracts';
import type { SelectOption } from '../ui/types';
import { isAvifLossless, isJxlLossless, isWebpLossless, withEncoderOptions } from './knobs';

/* -------------------------------------------------------------------------- */
/* Field descriptors                                                           */
/* -------------------------------------------------------------------------- */

interface FieldBase {
  /** Stable within an encoder — used as the `{#each}` key and the label id. */
  id: string;
  label: string;
  /** Muted second line under the label. */
  hint?: string;
  disabled?: boolean;
}

export interface AdvancedSelectField extends FieldBase {
  kind: 'select';
  value: string;
  options: readonly SelectOption[];
  apply(next: string): SideSettings;
}

export interface AdvancedSliderField extends FieldBase {
  kind: 'slider';
  value: number;
  min: number;
  max: number;
  step: number;
  /** Overrides the numeric readout, e.g. `Auto`. */
  valueText?: string;
  apply(next: number): SideSettings;
}

export interface AdvancedCheckboxField extends FieldBase {
  kind: 'checkbox';
  value: boolean;
  apply(next: boolean): SideSettings;
}

export type AdvancedField = AdvancedSelectField | AdvancedSliderField | AdvancedCheckboxField;

/** One column of the drawer's 4-up grid. */
export interface AdvancedColumn {
  id: string;
  fields: readonly AdvancedField[];
}

/* -------------------------------------------------------------------------- */
/* Memory                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The "last lossy value" memory the old panels kept in component state.
 * Turning Lossless off should restore what the user had, not the codec
 * default — so the drawer keeps one of these alive and refreshes it from the
 * current options on every change.
 */
export interface OptionMemory {
  avifQuality: number;
  avifSubsample: AvifSubsample;
  jxlQuality: number;
  jxlEpf: number;
}

export function createOptionMemory(): OptionMemory {
  return { avifQuality: 50, avifSubsample: 1, jxlQuality: 90, jxlEpf: 2 };
}

/**
 * Fold the current settings into the memory. Returns the same object when
 * nothing changed, so an `$effect` can assign unconditionally without looping.
 */
export function rememberOptions(memory: OptionMemory, settings: SideSettings): OptionMemory {
  if (settings.encoderId === 'avif') {
    const options = settings.encoderOptions;
    if (isAvifLossless(options)) return memory;
    if (options.quality === memory.avifQuality && options.subsample === memory.avifSubsample) {
      return memory;
    }
    return { ...memory, avifQuality: options.quality, avifSubsample: options.subsample };
  }

  if (settings.encoderId === 'jxl') {
    const options = settings.encoderOptions;
    const quality = isJxlLossless(options) ? memory.jxlQuality : options.quality;
    const epf = options.epf === -1 ? memory.jxlEpf : options.epf;
    if (quality === memory.jxlQuality && epf === memory.jxlEpf) return memory;
    return { ...memory, jxlQuality: quality, jxlEpf: epf };
  }

  return memory;
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                                */
/* -------------------------------------------------------------------------- */

/** Restore this encoder's shipped defaults, keeping resize and encoder id. */
export function resetToDefaults(settings: SideSettings): SideSettings {
  return withEncoderOptions(settings, defaultOptionsFor(settings.encoderId));
}

/** Copy for encoders with an empty drawer. */
export function advancedNote(id: EncoderId): string {
  switch (id) {
    case 'qoi':
      return 'QOI has no tunable options — it is always lossless, fast to encode, and simple.';
    case 'browser-png':
      return "This uses the browser's built-in PNG encoder — there is nothing to tune.";
    case 'browser-jpeg':
    case 'browser-webp':
      return "This uses the browser's built-in encoder — quality is the only dial it exposes.";
    case 'identity':
      return 'The original file is passed through untouched — there is nothing to encode.';
    default:
      return 'This encoder has no advanced options.';
  }
}

/** The full option set of the current encoder, grouped into the comp's columns. */
export function advancedColumns(
  settings: SideSettings,
  memory: OptionMemory,
): readonly AdvancedColumn[] {
  switch (settings.encoderId) {
    case 'mozjpeg':
      return mozjpegColumns(settings, settings.encoderOptions);
    case 'avif':
      return avifColumns(settings, settings.encoderOptions, memory);
    case 'jxl':
      return jxlColumns(settings, settings.encoderOptions, memory);
    case 'webp':
      return webpColumns(settings, settings.encoderOptions);
    case 'oxipng':
      return oxipngColumns(settings, settings.encoderOptions);
    default:
      return [];
  }
}

/** Total fields on screen — the drawer uses it to decide between grid and note. */
export function countFields(columns: readonly AdvancedColumn[]): number {
  return columns.reduce((total, column) => total + column.fields.length, 0);
}

/* -------------------------------------------------------------------------- */
/* MozJPEG                                                                     */
/* -------------------------------------------------------------------------- */

const QUANT_TABLES: readonly SelectOption[] = [
  { value: '0', label: 'JPEG Annex K' },
  { value: '1', label: 'Flat' },
  { value: '2', label: 'MSSIM-tuned Kodak' },
  { value: '3', label: 'ImageMagick' },
  { value: '4', label: 'PSNR-HVS-M-tuned Kodak' },
  { value: '5', label: 'Klein et al' },
  { value: '6', label: 'Watson et al' },
  { value: '7', label: 'Ahumada et al' },
  { value: '8', label: 'Peterson et al' },
];

function mozjpegColumns(
  settings: SideSettings,
  options: MozJpegEncodeOptions,
): readonly AdvancedColumn[] {
  const emit = (patch: Partial<MozJpegEncodeOptions>): SideSettings =>
    withEncoderOptions(settings, { ...options, ...patch });

  const ycbcr = options.color_space === 3;

  const channels: AdvancedField = {
    kind: 'select',
    id: 'color_space',
    label: 'Channels',
    value: String(options.color_space),
    options: [
      { value: '1', label: 'Grayscale' },
      { value: '2', label: 'RGB' },
      { value: '3', label: 'YCbCr' },
    ],
    apply: (next) => emit({ color_space: Number(next) as MozJpegColorSpaceValue }),
  };

  const quantization: AdvancedField = {
    kind: 'select',
    id: 'quant_table',
    label: 'Quantization',
    value: String(options.quant_table),
    options: QUANT_TABLES,
    apply: (next) => emit({ quant_table: Number(next) }),
  };

  const sliders: AdvancedField[] = [
    {
      kind: 'slider',
      id: 'smoothing',
      label: 'Smoothing',
      value: options.smoothing,
      min: 0,
      max: 100,
      step: 1,
      apply: (next) => emit({ smoothing: next }),
    },
    {
      kind: 'slider',
      id: 'trellis_loops',
      label: 'Trellis passes',
      value: options.trellis_loops,
      min: 1,
      max: 50,
      step: 1,
      apply: (next) => emit({ trellis_loops: next }),
    },
  ];

  if (ycbcr && !options.auto_subsample) {
    sliders.push({
      kind: 'slider',
      id: 'chroma_subsample',
      label: 'Subsample chroma by',
      value: options.chroma_subsample,
      min: 1,
      max: 4,
      step: 1,
      apply: (next) => emit({ chroma_subsample: next }),
    });
  }
  if (ycbcr && options.separate_chroma_quality) {
    sliders.push({
      kind: 'slider',
      id: 'chroma_quality',
      label: 'Chroma quality',
      value: options.chroma_quality,
      min: 0,
      max: 100,
      step: 1,
      apply: (next) => emit({ chroma_quality: next }),
    });
  }

  const chroma: AdvancedField[] = [];
  if (ycbcr) {
    chroma.push(
      {
        kind: 'checkbox',
        id: 'auto_subsample',
        label: 'Auto subsample chroma',
        value: options.auto_subsample,
        apply: (next) => emit({ auto_subsample: next }),
      },
      {
        kind: 'checkbox',
        id: 'separate_chroma_quality',
        label: 'Separate chroma quality',
        value: options.separate_chroma_quality,
        apply: (next) => emit({ separate_chroma_quality: next }),
      },
    );
  }
  chroma.push({
    kind: 'checkbox',
    id: 'baseline',
    label: 'Pointless spec compliance',
    value: options.baseline,
    apply: (next) => emit({ baseline: next }),
  });

  const structure: AdvancedField[] = [
    options.baseline
      ? {
          kind: 'checkbox',
          id: 'optimize_coding',
          label: 'Optimize Huffman table',
          value: options.optimize_coding,
          apply: (next) => emit({ optimize_coding: next }),
        }
      : {
          kind: 'checkbox',
          id: 'progressive',
          label: 'Progressive rendering',
          value: options.progressive,
          apply: (next) => emit({ progressive: next }),
        },
    {
      kind: 'checkbox',
      id: 'trellis_multipass',
      label: 'Trellis multipass',
      value: options.trellis_multipass,
      apply: (next) => emit({ trellis_multipass: next }),
    },
  ];

  if (options.trellis_multipass) {
    structure.push({
      kind: 'checkbox',
      id: 'trellis_opt_zero',
      label: 'Optimize zero block runs',
      value: options.trellis_opt_zero,
      apply: (next) => emit({ trellis_opt_zero: next }),
    });
  }

  structure.push({
    kind: 'checkbox',
    id: 'trellis_opt_table',
    label: 'Optimize after trellis',
    value: options.trellis_opt_table,
    apply: (next) => emit({ trellis_opt_table: next }),
  });

  return [
    { id: 'format', fields: [channels, quantization] },
    { id: 'tuning', fields: sliders },
    { id: 'chroma', fields: chroma },
    { id: 'structure', fields: structure },
  ];
}

/* -------------------------------------------------------------------------- */
/* AVIF                                                                        */
/* -------------------------------------------------------------------------- */

function avifColumns(
  settings: SideSettings,
  options: AvifEncodeOptions,
  memory: OptionMemory,
): readonly AdvancedColumn[] {
  const emit = (patch: Partial<AvifEncodeOptions>): SideSettings =>
    withEncoderOptions(settings, { ...options, ...patch });

  const lossless = isAvifLossless(options);
  const separateAlpha = options.qualityAlpha !== -1;

  const mode: AdvancedField[] = [
    {
      kind: 'checkbox',
      id: 'lossless',
      label: 'Lossless',
      value: lossless,
      apply: (next) =>
        next
          ? emit({ quality: 100, qualityAlpha: -1, subsample: 3 })
          : emit({ quality: memory.avifQuality, subsample: memory.avifSubsample }),
    },
    {
      // Effort is the inverse of libavif's "speed": 10 − speed.
      kind: 'slider',
      id: 'effort',
      label: 'Effort',
      value: 10 - options.speed,
      min: 0,
      max: 10,
      step: 1,
      apply: (next) => emit({ speed: 10 - next }),
    },
  ];

  if (lossless) {
    return [
      { id: 'mode', fields: mode },
      { id: 'tiles', fields: avifTileFields(emit, options) },
    ];
  }

  const chroma: AdvancedField[] = [
    {
      kind: 'select',
      id: 'subsample',
      label: 'Subsample chroma',
      value: String(options.subsample),
      options: [
        { value: '0', label: '4:0:0 (greyscale)' },
        { value: '1', label: '4:2:0' },
        { value: '2', label: '4:2:2' },
        { value: '3', label: '4:4:4' },
      ],
      apply: (next) => emit({ subsample: Number(next) as AvifSubsample }),
    },
  ];

  if (options.subsample === 1) {
    chroma.push({
      kind: 'checkbox',
      id: 'enableSharpYUV',
      label: 'Sharp YUV downsampling',
      value: options.enableSharpYUV,
      apply: (next) => emit({ enableSharpYUV: next }),
    });
  }

  chroma.push(
    {
      kind: 'checkbox',
      id: 'chromaDeltaQ',
      label: 'Extra chroma compression',
      value: options.chromaDeltaQ,
      apply: (next) => emit({ chromaDeltaQ: next }),
    },
    {
      kind: 'select',
      id: 'tune',
      label: 'Tuning',
      value: String(options.tune),
      options: [
        { value: '0', label: 'Auto' },
        { value: '1', label: 'PSNR' },
        { value: '2', label: 'SSIM' },
      ],
      apply: (next) => emit({ tune: Number(next) as AvifTune }),
    },
  );

  const alpha: AdvancedField[] = [
    {
      kind: 'checkbox',
      id: 'separateAlpha',
      label: 'Separate alpha quality',
      value: separateAlpha,
      apply: (next) => emit({ qualityAlpha: next ? options.quality : -1 }),
    },
  ];

  if (separateAlpha) {
    alpha.push({
      kind: 'slider',
      id: 'qualityAlpha',
      label: 'Alpha quality',
      value: options.qualityAlpha,
      min: 0,
      max: 100,
      step: 1,
      apply: (next) => emit({ qualityAlpha: next }),
    });
  }

  alpha.push(
    {
      kind: 'slider',
      id: 'sharpness',
      label: 'Sharpness',
      value: options.sharpness,
      min: 0,
      max: 7,
      step: 1,
      apply: (next) => emit({ sharpness: next }),
    },
    {
      kind: 'slider',
      id: 'denoiseLevel',
      label: 'Noise synthesis',
      value: options.denoiseLevel,
      min: 0,
      max: 50,
      step: 1,
      apply: (next) => emit({ denoiseLevel: next }),
    },
  );

  return [
    { id: 'mode', fields: mode },
    { id: 'chroma', fields: chroma },
    { id: 'alpha', fields: alpha },
    { id: 'tiles', fields: avifTileFields(emit, options) },
  ];
}

function avifTileFields(
  emit: (patch: Partial<AvifEncodeOptions>) => SideSettings,
  options: AvifEncodeOptions,
): AdvancedField[] {
  return [
    {
      kind: 'slider',
      id: 'tileRowsLog2',
      label: 'Log2 of tile rows',
      value: options.tileRowsLog2,
      min: 0,
      max: 6,
      step: 1,
      apply: (next) => emit({ tileRowsLog2: next }),
    },
    {
      kind: 'slider',
      id: 'tileColsLog2',
      label: 'Log2 of tile cols',
      value: options.tileColsLog2,
      min: 0,
      max: 6,
      step: 1,
      apply: (next) => emit({ tileColsLog2: next }),
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* JPEG XL                                                                     */
/* -------------------------------------------------------------------------- */

function jxlColumns(
  settings: SideSettings,
  options: JxlEncodeOptions,
  memory: OptionMemory,
): readonly AdvancedColumn[] {
  const emit = (patch: Partial<JxlEncodeOptions>): SideSettings =>
    withEncoderOptions(settings, { ...options, ...patch });

  const lossless = isJxlLossless(options);
  const autoEdgeFilter = options.epf === -1;
  // Below quality 7 libjxl only has the modular path, so the switch locks on.
  const forcedModular = options.quality < 7;

  const mode: AdvancedField[] = [
    {
      kind: 'checkbox',
      id: 'lossless',
      label: 'Lossless',
      value: lossless,
      apply: (next) => emit({ quality: next ? 100 : memory.jxlQuality }),
    },
    {
      kind: 'slider',
      id: 'effort',
      label: 'Effort',
      value: options.effort,
      min: 1,
      max: 9,
      step: 1,
      apply: (next) => emit({ effort: next }),
    },
    {
      kind: 'checkbox',
      id: 'progressive',
      label: 'Progressive rendering',
      value: options.progressive,
      apply: (next) => emit({ progressive: next }),
    },
  ];

  if (lossless) {
    return [
      { id: 'mode', fields: mode },
      {
        id: 'palette',
        fields: [
          {
            kind: 'checkbox',
            id: 'lossyPalette',
            label: 'Slight loss (palette)',
            value: options.lossyPalette,
            apply: (next) => emit({ lossyPalette: next }),
          },
        ],
      },
    ];
  }

  const filter: AdvancedField[] = [
    {
      kind: 'checkbox',
      id: 'lossyModular',
      label: 'Alternative lossy mode',
      hint: forcedModular ? 'Forced below quality 7' : undefined,
      value: forcedModular ? true : options.lossyModular,
      disabled: forcedModular,
      apply: (next) => emit({ lossyModular: next }),
    },
    {
      kind: 'checkbox',
      id: 'autoEpf',
      label: 'Auto edge filter',
      value: autoEdgeFilter,
      apply: (next) => emit({ epf: next ? -1 : memory.jxlEpf }),
    },
  ];

  if (!autoEdgeFilter) {
    filter.push({
      kind: 'slider',
      id: 'epf',
      label: 'Edge preserving filter',
      value: options.epf,
      min: 0,
      max: 3,
      step: 1,
      apply: (next) => emit({ epf: next }),
    });
  }

  return [
    { id: 'mode', fields: mode },
    { id: 'filter', fields: filter },
    {
      id: 'decoding',
      fields: [
        {
          kind: 'slider',
          id: 'decodingSpeedTier',
          label: 'Optimise for decoding speed',
          value: options.decodingSpeedTier,
          min: 0,
          max: 4,
          step: 1,
          apply: (next) => emit({ decodingSpeedTier: next }),
        },
      ],
    },
    {
      id: 'grain',
      fields: [
        {
          kind: 'slider',
          id: 'photonNoiseIso',
          label: 'Noise equivalent to ISO',
          value: options.photonNoiseIso,
          min: 0,
          max: 50000,
          step: 100,
          valueText: options.photonNoiseIso === 0 ? 'Off' : String(options.photonNoiseIso),
          apply: (next) => emit({ photonNoiseIso: next }),
        },
      ],
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* WebP                                                                        */
/* -------------------------------------------------------------------------- */

function webpColumns(
  settings: SideSettings,
  options: WebpEncodeOptions,
): readonly AdvancedColumn[] {
  const emit = (patch: Partial<WebpEncodeOptions>): SideSettings =>
    withEncoderOptions(settings, { ...options, ...patch });

  const lossless = isWebpLossless(options);

  const mode: AdvancedField[] = [
    {
      kind: 'checkbox',
      id: 'lossless',
      label: 'Lossless',
      value: lossless,
      apply: (next) => emit({ lossless: next ? 1 : 0 }),
    },
    {
      kind: 'checkbox',
      id: 'exact',
      label: 'Preserve transparent data',
      value: options.exact === 1,
      apply: (next) => emit({ exact: next ? 1 : 0 }),
    },
  ];

  if (lossless) {
    return [
      { id: 'mode', fields: mode },
      {
        id: 'near-lossless',
        fields: [
          {
            // near_lossless is inverted: 100 means "no loss at all".
            kind: 'slider',
            id: 'near_lossless',
            label: 'Slight loss',
            value: 100 - options.near_lossless,
            min: 0,
            max: 100,
            step: 1,
            apply: (next) => emit({ near_lossless: 100 - next }),
          },
          {
            kind: 'checkbox',
            id: 'image_hint',
            label: 'Discrete tone image',
            value: options.image_hint === 3,
            apply: (next) => emit({ image_hint: next ? 3 : 0 }),
          },
        ],
      },
    ];
  }

  mode.push({
    kind: 'slider',
    id: 'method',
    label: 'Effort',
    value: options.method,
    min: 0,
    max: 6,
    step: 1,
    apply: (next) => emit({ method: next }),
  });

  const alpha: AdvancedField[] = [
    {
      kind: 'checkbox',
      id: 'alpha_compression',
      label: 'Compress alpha',
      value: options.alpha_compression === 1,
      apply: (next) => emit({ alpha_compression: next ? 1 : 0 }),
    },
    {
      kind: 'slider',
      id: 'alpha_quality',
      label: 'Alpha quality',
      value: options.alpha_quality,
      min: 0,
      max: 100,
      step: 1,
      apply: (next) => emit({ alpha_quality: next }),
    },
    {
      kind: 'slider',
      id: 'alpha_filtering',
      label: 'Alpha filter quality',
      value: options.alpha_filtering,
      min: 0,
      max: 2,
      step: 1,
      apply: (next) => emit({ alpha_filtering: next }),
    },
  ];

  const filter: AdvancedField[] = [
    {
      kind: 'checkbox',
      id: 'autofilter',
      label: 'Auto adjust filter strength',
      value: options.autofilter === 1,
      apply: (next) => emit({ autofilter: next ? 1 : 0 }),
    },
  ];

  if (options.autofilter !== 1) {
    filter.push({
      kind: 'slider',
      id: 'filter_strength',
      label: 'Filter strength',
      value: options.filter_strength,
      min: 0,
      max: 100,
      step: 1,
      apply: (next) => emit({ filter_strength: next }),
    });
  }

  filter.push(
    {
      kind: 'checkbox',
      id: 'filter_type',
      label: 'Strong filter',
      value: options.filter_type === 1,
      apply: (next) => emit({ filter_type: next ? 1 : 0 }),
    },
    {
      // Shown inverted: a smaller raw value is a sharper filter.
      kind: 'slider',
      id: 'filter_sharpness',
      label: 'Filter sharpness',
      value: 7 - options.filter_sharpness,
      min: 0,
      max: 7,
      step: 1,
      apply: (next) => emit({ filter_sharpness: 7 - next }),
    },
    {
      kind: 'checkbox',
      id: 'use_sharp_yuv',
      label: 'Sharp RGB to YUV conversion',
      value: options.use_sharp_yuv === 1,
      apply: (next) => emit({ use_sharp_yuv: next ? 1 : 0 }),
    },
  );

  const analysis: AdvancedField[] = [
    {
      kind: 'select',
      id: 'preprocessing',
      label: 'Preprocess',
      value: String(options.preprocessing),
      options: [
        { value: '0', label: 'None' },
        { value: '1', label: 'Segment smooth' },
        { value: '2', label: 'Pseudo-random dithering' },
      ],
      apply: (next) => emit({ preprocessing: Number(next) }),
    },
    {
      kind: 'slider',
      id: 'pass',
      label: 'Passes',
      value: options.pass,
      min: 1,
      max: 10,
      step: 1,
      apply: (next) => emit({ pass: next }),
    },
    {
      kind: 'slider',
      id: 'sns_strength',
      label: 'Spatial noise shaping',
      value: options.sns_strength,
      min: 0,
      max: 100,
      step: 1,
      apply: (next) => emit({ sns_strength: next }),
    },
    {
      kind: 'slider',
      id: 'segments',
      label: 'Segments',
      value: options.segments,
      min: 1,
      max: 4,
      step: 1,
      apply: (next) => emit({ segments: next }),
    },
    {
      kind: 'slider',
      id: 'partitions',
      label: 'Partitions',
      value: options.partitions,
      min: 0,
      max: 3,
      step: 1,
      apply: (next) => emit({ partitions: next }),
    },
  ];

  return [
    { id: 'mode', fields: mode },
    { id: 'alpha', fields: alpha },
    { id: 'filter', fields: filter },
    { id: 'analysis', fields: analysis },
  ];
}

/* -------------------------------------------------------------------------- */
/* OxiPNG                                                                      */
/* -------------------------------------------------------------------------- */

function oxipngColumns(
  settings: SideSettings,
  options: OxiPngEncodeOptions,
): readonly AdvancedColumn[] {
  const emit = (patch: Partial<OxiPngEncodeOptions>): SideSettings =>
    withEncoderOptions(settings, { ...options, ...patch });

  return [
    {
      id: 'output',
      fields: [
        {
          kind: 'checkbox',
          id: 'interlace',
          label: 'Interlace',
          value: options.interlace,
          apply: (next) => emit({ interlace: next }),
        },
        {
          kind: 'checkbox',
          id: 'optimiseAlpha',
          label: 'Optimise alpha channel',
          hint: 'Changes fully transparent pixels — not byte-identical',
          value: options.optimiseAlpha,
          apply: (next) => emit({ optimiseAlpha: next }),
        },
      ],
    },
  ];
}
