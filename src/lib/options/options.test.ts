/**
 * The pure half of the editor controls: the primary-knob mapping, the derived
 * "lossless" switches, the advanced field descriptors and the formatters.
 *
 * The components themselves are exercised by the editor screen; everything
 * that can be wrong about a *codec option* is decided by the functions below,
 * so that is what is pinned here — in particular the mappings inherited from
 * the panels this module replaced (AVIF effort, WebP presets, JXL epf…).
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ENCODER_OPTIONS,
  createSideSettings,
  type AvifEncodeOptions,
  type JxlEncodeOptions,
  type MozJpegEncodeOptions,
  type SideSettings,
  type WebpEncodeOptions,
} from '../contracts';

import {
  advancedColumns,
  advancedNote,
  countFields,
  createOptionMemory,
  rememberOptions,
  resetToDefaults,
  type AdvancedColumn,
  type AdvancedField,
} from './advanced';
import {
  ENCODER_NOTE,
  encoderNote,
  hasAdvanced,
  isAvifLossless,
  isJxlLossless,
  isWebpLossless,
  primaryKnob,
  webpLosslessPreset,
  webpLosslessPresetValues,
  withEncoderOptions,
} from './knobs';
import {
  formatBytes,
  formatDelta,
  formatDimensions,
  formatQuality,
  formatSavings,
  formatSsim,
} from './format';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function fields(columns: readonly AdvancedColumn[]): AdvancedField[] {
  return columns.flatMap((column) => [...column.fields]);
}

function ids(columns: readonly AdvancedColumn[]): string[] {
  return fields(columns).map((field) => field.id);
}

function find(columns: readonly AdvancedColumn[], id: string): AdvancedField {
  const field = fields(columns).find((candidate) => candidate.id === id);
  if (!field) throw new Error(`no field "${id}" — got ${ids(columns).join(', ')}`);
  return field;
}

function checkbox(columns: readonly AdvancedColumn[], id: string) {
  const field = find(columns, id);
  if (field.kind !== 'checkbox') throw new Error(`"${id}" is a ${field.kind}, not a checkbox`);
  return field;
}

function slider(columns: readonly AdvancedColumn[], id: string) {
  const field = find(columns, id);
  if (field.kind !== 'slider') throw new Error(`"${id}" is a ${field.kind}, not a slider`);
  return field;
}

function select(columns: readonly AdvancedColumn[], id: string) {
  const field = find(columns, id);
  if (field.kind !== 'select') throw new Error(`"${id}" is a ${field.kind}, not a select`);
  return field;
}

const memory = createOptionMemory();

const DEFAULT_RESIZE = {
  enabled: false,
  width: 1,
  height: 1,
  method: 'lanczos3',
  premultiply: true,
  linearRGB: true,
  fitMethod: 'stretch',
} as const;

/** Built one literal at a time: `createSideSettings` over a *union* of ids
 *  widens `encoderOptions` and stops matching the discriminated union. */
const OPTION_FREE: readonly SideSettings[] = [
  createSideSettings('qoi'),
  createSideSettings('browser-png'),
  createSideSettings('identity'),
];

function avif(patch: Partial<AvifEncodeOptions> = {}): SideSettings {
  return createSideSettings('avif', patch);
}

function jxl(patch: Partial<JxlEncodeOptions> = {}): SideSettings {
  return createSideSettings('jxl', patch);
}

function webp(patch: Partial<WebpEncodeOptions> = {}): SideSettings {
  return createSideSettings('webp', patch);
}

function mozjpeg(patch: Partial<MozJpegEncodeOptions> = {}): SideSettings {
  return createSideSettings('mozjpeg', patch);
}

/* -------------------------------------------------------------------------- */
/* Primary knob                                                                */
/* -------------------------------------------------------------------------- */

describe('primaryKnob', () => {
  it('drives quality for the lossy codecs', () => {
    const knob = primaryKnob(mozjpeg({ quality: 62 }));
    expect(knob.kind).toBe('quality');
    expect(knob.label).toBe('Quality');
    expect(knob.value).toBe(62);
    expect(knob.valueText).toBe('62');
    expect(knob.ticks).toEqual([0, 25, 50, 75, 100]);

    const next = knob.apply(80);
    expect(next.encoderId).toBe('mozjpeg');
    expect(next.encoderOptions).toMatchObject({ quality: 80 });
  });

  it('keeps the resize state when quality changes', () => {
    const base = createSideSettings('mozjpeg', undefined, {
      resize: { ...DEFAULT_RESIZE, enabled: true, width: 800, height: 600 },
    });
    const next = primaryKnob(base).apply(40);
    expect(next.processorState.resize).toMatchObject({ enabled: true, width: 800, height: 600 });
  });

  it('shows JPEG XL fractional quality without trailing zeros', () => {
    expect(primaryKnob(jxl({ quality: 75 })).valueText).toBe('75');
    expect(primaryKnob(jxl({ quality: 75.5 })).valueText).toBe('75.5');
    expect(primaryKnob(jxl({ quality: 75 })).step).toBe(0.1);
  });

  it('locks the slider when AVIF or JPEG XL is lossless', () => {
    const losslessAvif = primaryKnob(avif({ quality: 100, qualityAlpha: -1, subsample: 3 }));
    expect(losslessAvif.disabled).toBe(true);
    expect(losslessAvif.note).toBe('Lossless');

    const losslessJxl = primaryKnob(jxl({ quality: 100 }));
    expect(losslessJxl.disabled).toBe(true);

    expect(primaryKnob(avif({ quality: 100 })).disabled).toBe(false); // 4:2:0 ⇒ still lossy
  });

  it('swaps WebP quality for the libwebp preset ladder in lossless mode', () => {
    const knob = primaryKnob(webp({ lossless: 1, method: 4, quality: 90 }));
    expect(knob.kind).toBe('effort');
    expect(knob.label).toBe('Effort');
    expect(knob.value).toBe(7);

    const next = knob.apply(9);
    expect(next.encoderOptions).toMatchObject({ method: 6, quality: 100, lossless: 1 });
  });

  it('uses effort, not quality, for OxiPNG', () => {
    const knob = primaryKnob(createSideSettings('oxipng', { level: 4 }));
    expect(knob.kind).toBe('effort');
    expect(knob.max).toBe(6);
    expect(knob.apply(6).encoderOptions).toMatchObject({ level: 6 });
  });

  it('scales the canvas encoders from 0–1 to 0–100', () => {
    const knob = primaryKnob(createSideSettings('browser-jpeg', { quality: 0.75 }));
    expect(knob.value).toBe(75);
    expect(knob.apply(40).encoderOptions).toMatchObject({ quality: 0.4 });
  });

  it('has no knob for the option-free encoders', () => {
    for (const settings of OPTION_FREE) {
      const knob = primaryKnob(settings);
      expect(knob.kind).toBe('none');
      expect(knob.disabled).toBe(true);
      expect(knob.apply(50)).toBe(settings);
    }
    expect(primaryKnob(createSideSettings('identity')).note).toBeUndefined();
    expect(primaryKnob(createSideSettings('qoi')).note).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* Derived lossless switches                                                   */
/* -------------------------------------------------------------------------- */

describe('lossless derivation', () => {
  it('reads AVIF lossless off quality + alpha + subsample together', () => {
    expect(isAvifLossless({ ...DEFAULT_ENCODER_OPTIONS.avif, quality: 100, subsample: 3 })).toBe(
      true,
    );
    expect(
      isAvifLossless({
        ...DEFAULT_ENCODER_OPTIONS.avif,
        quality: 100,
        subsample: 3,
        qualityAlpha: 100,
      }),
    ).toBe(true);
    expect(
      isAvifLossless({
        ...DEFAULT_ENCODER_OPTIONS.avif,
        quality: 100,
        subsample: 3,
        qualityAlpha: 60,
      }),
    ).toBe(false);
    expect(isAvifLossless({ ...DEFAULT_ENCODER_OPTIONS.avif, quality: 99, subsample: 3 })).toBe(
      false,
    );
  });

  it('reads JPEG XL lossless as quality 100 exactly', () => {
    expect(isJxlLossless({ ...DEFAULT_ENCODER_OPTIONS.jxl, quality: 100 })).toBe(true);
    expect(isJxlLossless({ ...DEFAULT_ENCODER_OPTIONS.jxl, quality: 99.9 })).toBe(false);
  });

  it("reads WebP lossless off libwebp's 0|1 int", () => {
    expect(isWebpLossless({ ...DEFAULT_ENCODER_OPTIONS.webp, lossless: 1 })).toBe(true);
    expect(isWebpLossless({ ...DEFAULT_ENCODER_OPTIONS.webp, lossless: 0 })).toBe(false);
  });

  it('maps every libwebp lossless preset back and forth', () => {
    for (let index = 0; index < 10; index += 1) {
      const values = webpLosslessPresetValues(index);
      expect(webpLosslessPreset({ ...DEFAULT_ENCODER_OPTIONS.webp, ...values })).toBe(index);
    }
    // An off-ladder pair falls back to libwebp's own default step.
    expect(webpLosslessPreset({ ...DEFAULT_ENCODER_OPTIONS.webp, method: 2, quality: 77 })).toBe(6);
  });
});

/* -------------------------------------------------------------------------- */
/* Memory                                                                      */
/* -------------------------------------------------------------------------- */

describe('option memory', () => {
  it('restores the last lossy AVIF quality and subsample', () => {
    const lossy = avif({ quality: 38, subsample: 2 });
    const remembered = rememberOptions(createOptionMemory(), lossy);
    expect(remembered).toMatchObject({ avifQuality: 38, avifSubsample: 2 });

    const columns = advancedColumns(lossy, remembered);
    const losslessOn = checkbox(columns, 'lossless').apply(true);
    expect(losslessOn.encoderOptions).toMatchObject({
      quality: 100,
      qualityAlpha: -1,
      subsample: 3,
    });

    const back = checkbox(advancedColumns(losslessOn, remembered), 'lossless').apply(false);
    expect(back.encoderOptions).toMatchObject({ quality: 38, subsample: 2 });
  });

  it('never overwrites the remembered value from a lossless state', () => {
    const remembered = rememberOptions(createOptionMemory(), avif({ quality: 38, subsample: 2 }));
    const stillRemembered = rememberOptions(
      remembered,
      avif({ quality: 100, qualityAlpha: -1, subsample: 3 }),
    );
    expect(stillRemembered.avifQuality).toBe(38);
  });

  it('returns the same object when nothing changed, so effects settle', () => {
    const start = createOptionMemory();
    expect(rememberOptions(start, mozjpeg())).toBe(start);
    const once = rememberOptions(start, jxl({ quality: 44, epf: 1 }));
    expect(rememberOptions(once, jxl({ quality: 44, epf: 1 }))).toBe(once);
  });

  it('remembers the explicit JPEG XL edge filter through auto', () => {
    const remembered = rememberOptions(createOptionMemory(), jxl({ epf: 3 }));
    expect(remembered.jxlEpf).toBe(3);

    const auto = checkbox(advancedColumns(jxl({ epf: 3 }), remembered), 'autoEpf').apply(true);
    expect(auto.encoderOptions).toMatchObject({ epf: -1 });

    const restored = checkbox(advancedColumns(auto, remembered), 'autoEpf').apply(false);
    expect(restored.encoderOptions).toMatchObject({ epf: 3 });
  });
});

/* -------------------------------------------------------------------------- */
/* Advanced columns                                                            */
/* -------------------------------------------------------------------------- */

describe('advancedColumns', () => {
  it('fits the comp grid: never more than four columns, never an empty one', () => {
    for (const settings of [avif(), jxl(), webp(), mozjpeg(), createSideSettings('oxipng')]) {
      const columns = advancedColumns(settings, memory);
      expect(columns.length).toBeGreaterThan(0);
      expect(columns.length).toBeLessThanOrEqual(4);
      for (const column of columns) expect(column.fields.length).toBeGreaterThan(0);
    }
  });

  it('gives every field a unique id', () => {
    for (const settings of [avif(), jxl(), webp(), mozjpeg(), createSideSettings('oxipng')]) {
      const all = ids(advancedColumns(settings, memory));
      expect(new Set(all).size).toBe(all.length);
    }
  });

  it('exposes every MozJPEG option the old panel did', () => {
    const ycbcr = advancedColumns(
      mozjpeg({ auto_subsample: false, separate_chroma_quality: true, trellis_multipass: true }),
      memory,
    );
    expect(ids(ycbcr)).toEqual(
      expect.arrayContaining([
        'color_space',
        'quant_table',
        'smoothing',
        'trellis_loops',
        'chroma_subsample',
        'chroma_quality',
        'auto_subsample',
        'separate_chroma_quality',
        'baseline',
        'progressive',
        'trellis_multipass',
        'trellis_opt_zero',
        'trellis_opt_table',
      ]),
    );
  });

  it('hides the chroma controls outside YCbCr, as MozJPEG requires', () => {
    const grayscale = advancedColumns(mozjpeg({ color_space: 1 }), memory);
    expect(ids(grayscale)).not.toContain('auto_subsample');
    expect(ids(grayscale)).not.toContain('separate_chroma_quality');
    expect(ids(grayscale)).toContain('quant_table');
  });

  it('swaps progressive rendering for the Huffman option in baseline mode', () => {
    expect(ids(advancedColumns(mozjpeg({ baseline: false }), memory))).toContain('progressive');
    const baseline = advancedColumns(mozjpeg({ baseline: true }), memory);
    expect(ids(baseline)).toContain('optimize_coding');
    expect(ids(baseline)).not.toContain('progressive');
  });

  it('displays AVIF effort as 10 − speed', () => {
    const effort = slider(advancedColumns(avif({ speed: 6 }), memory), 'effort');
    expect(effort.value).toBe(4);
    expect(effort.apply(9).encoderOptions).toMatchObject({ speed: 1 });
  });

  it('offers sharp YUV only at 4:2:0, where downsampling actually happens', () => {
    expect(ids(advancedColumns(avif({ subsample: 1 }), memory))).toContain('enableSharpYUV');
    expect(ids(advancedColumns(avif({ subsample: 3 }), memory))).not.toContain('enableSharpYUV');
  });

  it('drops the lossy AVIF controls once lossless is on', () => {
    const lossless = advancedColumns(
      avif({ quality: 100, qualityAlpha: -1, subsample: 3 }),
      memory,
    );
    expect(ids(lossless)).toEqual(
      expect.arrayContaining(['lossless', 'effort', 'tileRowsLog2', 'tileColsLog2']),
    );
    expect(ids(lossless)).not.toContain('subsample');
    expect(ids(lossless)).not.toContain('separateAlpha');
  });

  it('follows AVIF alpha quality onto luma when it is separated', () => {
    const separate = checkbox(advancedColumns(avif({ quality: 44 }), memory), 'separateAlpha');
    expect(separate.value).toBe(false);
    expect(separate.apply(true).encoderOptions).toMatchObject({ qualityAlpha: 44 });
    const columns = advancedColumns(avif({ quality: 44, qualityAlpha: 44 }), memory);
    expect(slider(columns, 'qualityAlpha').value).toBe(44);
    expect(checkbox(columns, 'separateAlpha').apply(false).encoderOptions).toMatchObject({
      qualityAlpha: -1,
    });
  });

  it('locks the JPEG XL modular switch on below quality 7', () => {
    const forced = checkbox(advancedColumns(jxl({ quality: 5 }), memory), 'lossyModular');
    expect(forced.value).toBe(true);
    expect(forced.disabled).toBe(true);

    const free = checkbox(advancedColumns(jxl({ quality: 50 }), memory), 'lossyModular');
    expect(free.disabled).toBeFalsy();
  });

  it('inverts the WebP near-lossless and sharpness dials', () => {
    const slight = slider(advancedColumns(webp({ lossless: 1, near_lossless: 60 }), memory), 'near_lossless');
    expect(slight.value).toBe(40);
    expect(slight.apply(10).encoderOptions).toMatchObject({ near_lossless: 90 });

    const sharpness = slider(advancedColumns(webp({ filter_sharpness: 2 }), memory), 'filter_sharpness');
    expect(sharpness.value).toBe(5);
    expect(sharpness.apply(7).encoderOptions).toMatchObject({ filter_sharpness: 0 });
  });

  it('keeps libwebp booleans as 0|1 ints', () => {
    const columns = advancedColumns(webp(), memory);
    expect(checkbox(columns, 'exact').apply(true).encoderOptions).toMatchObject({ exact: 1 });
    expect(checkbox(columns, 'alpha_compression').apply(false).encoderOptions).toMatchObject({
      alpha_compression: 0,
    });
    expect(checkbox(columns, 'lossless').apply(true).encoderOptions).toMatchObject({ lossless: 1 });
  });

  it('hides the WebP filter stack in lossless mode', () => {
    const lossless = ids(advancedColumns(webp({ lossless: 1 }), memory));
    expect(lossless).toEqual(expect.arrayContaining(['lossless', 'near_lossless', 'image_hint']));
    expect(lossless).not.toContain('filter_strength');
    expect(lossless).not.toContain('sns_strength');
  });

  it('hides the WebP filter strength while autofilter is on', () => {
    expect(ids(advancedColumns(webp({ autofilter: 1 }), memory))).not.toContain('filter_strength');
    expect(ids(advancedColumns(webp({ autofilter: 0 }), memory))).toContain('filter_strength');
  });

  it('parses numeric selects back into their codec enums', () => {
    const channels = select(advancedColumns(mozjpeg(), memory), 'color_space');
    expect(channels.value).toBe('3');
    expect(channels.apply('1').encoderOptions).toMatchObject({ color_space: 1 });

    const subsample = select(advancedColumns(avif(), memory), 'subsample');
    expect(subsample.apply('2').encoderOptions).toMatchObject({ subsample: 2 });

    const preprocessing = select(advancedColumns(webp(), memory), 'preprocessing');
    expect(preprocessing.apply('2').encoderOptions).toMatchObject({ preprocessing: 2 });
  });

  it('leaves the drawer empty for the encoders with nothing to tune', () => {
    for (const settings of [...OPTION_FREE, createSideSettings('browser-jpeg')]) {
      expect(countFields(advancedColumns(settings, memory))).toBe(0);
      expect(advancedNote(settings.encoderId)).toMatch(/\w/);
      expect(hasAdvanced(settings.encoderId)).toBe(false);
    }
    expect(hasAdvanced('avif')).toBe(true);
  });

  it('never mutates the settings it was handed', () => {
    const before = avif({ quality: 44 });
    const snapshot = JSON.stringify(before);
    slider(advancedColumns(before, memory), 'effort').apply(2);
    checkbox(advancedColumns(before, memory), 'lossless').apply(true);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('resetToDefaults', () => {
  it('restores the codec defaults but keeps the encoder and the resize', () => {
    const dirty = createSideSettings('mozjpeg', { quality: 12, smoothing: 40 }, {
      resize: { ...DEFAULT_RESIZE, enabled: true, width: 640, height: 480 },
    });
    const reset = resetToDefaults(dirty);
    expect(reset.encoderId).toBe('mozjpeg');
    expect(reset.encoderOptions).toEqual(DEFAULT_ENCODER_OPTIONS.mozjpeg);
    expect(reset.processorState.resize).toMatchObject({ enabled: true, width: 640 });
  });
});

describe('withEncoderOptions', () => {
  it('replaces the options without touching the encoder or the resize', () => {
    const base = mozjpeg({ quality: 30 });
    const next = withEncoderOptions(base, { ...DEFAULT_ENCODER_OPTIONS.mozjpeg, quality: 90 });
    expect(next.encoderId).toBe('mozjpeg');
    expect(next.encoderOptions).toMatchObject({ quality: 90 });
    expect(next.processorState).toEqual(base.processorState);
  });
});

/* -------------------------------------------------------------------------- */
/* Notes                                                                       */
/* -------------------------------------------------------------------------- */

describe('encoder notes', () => {
  it('labels every encoder in the picker', () => {
    for (const [id, note] of Object.entries(ENCODER_NOTE)) {
      expect(note.length).toBeGreaterThan(0);
      expect(encoderNote(id as keyof typeof ENCODER_NOTE)).toBe(note);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Formatters                                                                  */
/* -------------------------------------------------------------------------- */

describe('formatters', () => {
  it('prints sizes the way the comp does', () => {
    expect(formatBytes(2_920_000)).toBe('2.92 MB');
    expect(formatBytes(390_000)).toBe('390 kB');
    expect(formatBytes(948)).toBe('948 B');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });

  it('uses a typographic minus for savings and flags regressions', () => {
    expect(formatSavings(2_920_000, 390_000)).toBe('−87%');
    expect(formatSavings(1000, 1200)).toBe('+20%');
    expect(formatSavings(1000, 1000)).toBe('0%');
    expect(formatSavings(0, 100)).toBe('0%');
  });

  it('describes the delta in words', () => {
    expect(formatDelta(2_920_000, 390_000)).toBe('2.53 MB saved');
    expect(formatDelta(1000, 1200)).toBe('200 B larger');
    expect(formatDelta(1000, 1000)).toBe('same size');
  });

  it('formats dimensions, SSIM and slider values', () => {
    expect(formatDimensions(4032, 3024)).toBe('4032 × 3024');
    expect(formatSsim(0.9941)).toBe('0.994');
    expect(formatSsim(null)).toBe('—');
    expect(formatSsim(undefined)).toBe('—');
    expect(formatQuality(75, 1)).toBe('75');
    expect(formatQuality(75.5, 0.1)).toBe('75.5');
    expect(formatQuality(75.5, 1)).toBe('76');
  });
});
