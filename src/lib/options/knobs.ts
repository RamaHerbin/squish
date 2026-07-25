/**
 * The intelligence that used to live inside the per-encoder option panels,
 * re-expressed as pure data so the toolbar, the mobile sheet and the advanced
 * drawer all read the same source of truth.
 *
 * Two ideas:
 *
 * - **Primary knob** — the single headline control the toolbar shows for the
 *   current encoder. Quality for the lossy codecs, effort for OxiPNG, the
 *   libwebp lossless preset for lossless WebP, nothing at all for `identity`.
 * - **Derived switches** — "lossless" is not a field on AVIF or JPEG XL: it is
 *   a *shape* of the real options (`quality === 100 && subsample === 4:4:4` and
 *   friends), exactly as Squoosh derives it. Those predicates live here so the
 *   drawer's checkbox and the toolbar's disabled slider always agree.
 *
 * Everything is a pure function of `SideSettings` — no component state.
 */

import type {
  AnyEncoderOptions,
  AvifEncodeOptions,
  EncoderId,
  JxlEncodeOptions,
  ProcessorState,
  SideSettings,
  WebpEncodeOptions,
} from '../contracts';
import { ENCODER_QUALITY_RANGE } from '../contracts';
import { formatQuality } from './format';

/* -------------------------------------------------------------------------- */
/* Union-safe writers                                                          */
/* -------------------------------------------------------------------------- */

/*
 * `SideSettings` is a discriminated union keyed by `encoderId`. Both helpers
 * below only ever replace a member whose type is identical across every union
 * arm (`processorState`), or an `encoderOptions` object that was produced from
 * the *current* arm's options — so the cast is sound even though TypeScript
 * cannot verify the K-to-K pairing across a spread. Never touch `encoderId`
 * this way; use `withEncoder` from the contracts for that.
 */

/** Replace the encoder options, keeping the encoder and processor state. */
export function withEncoderOptions(
  current: SideSettings,
  encoderOptions: AnyEncoderOptions,
): SideSettings {
  return { ...current, encoderOptions } as SideSettings;
}

/** Replace the processor state (resize), keeping the encoder untouched. */
export function withProcessorState(
  current: SideSettings,
  processorState: ProcessorState,
): SideSettings {
  return { ...current, processorState } as SideSettings;
}

/* -------------------------------------------------------------------------- */
/* Derived "lossless" switches                                                 */
/* -------------------------------------------------------------------------- */

/**
 * AVIF has no usable lossless flag in the option set we ship: lossless is
 * `quality 100` + full-resolution chroma + alpha following luma. Mirrors
 * `squoosh/src/features/encoders/avif/client/index.tsx`.
 */
export function isAvifLossless(options: AvifEncodeOptions): boolean {
  return (
    options.quality === 100 &&
    (options.qualityAlpha === -1 || options.qualityAlpha === 100) &&
    options.subsample === 3
  );
}

/** JPEG XL is lossless at exactly quality 100 (Squoosh's rule). */
export function isJxlLossless(options: JxlEncodeOptions): boolean {
  return options.quality === 100;
}

/** libwebp's `lossless` is a real 0|1 field, not a boolean. */
export function isWebpLossless(options: WebpEncodeOptions): boolean {
  return options.lossless === 1;
}

/**
 * `[method, quality]` per effort step — `kLosslessPresets` from libwebp's
 * `config_enc.c`. Lossless WebP only accepts these discrete pairs, so the UI
 * collapses both dials into one 0–9 "effort" index.
 */
export const WEBP_LOSSLESS_PRESETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 20],
  [2, 25],
  [3, 30],
  [3, 50],
  [4, 50],
  [4, 75],
  [4, 90],
  [5, 90],
  [6, 100],
];

const WEBP_LOSSLESS_PRESET_DEFAULT = 6;

/** Index into {@link WEBP_LOSSLESS_PRESETS}; falls back to libwebp's default. */
export function webpLosslessPreset(options: WebpEncodeOptions): number {
  const index = WEBP_LOSSLESS_PRESETS.findIndex(
    ([method, quality]) => method === options.method && quality === options.quality,
  );
  return index === -1 ? WEBP_LOSSLESS_PRESET_DEFAULT : index;
}

/** The `{ method, quality }` pair for a lossless effort step. */
export function webpLosslessPresetValues(index: number): { method: number; quality: number } {
  const preset =
    WEBP_LOSSLESS_PRESETS[index] ?? WEBP_LOSSLESS_PRESETS[WEBP_LOSSLESS_PRESET_DEFAULT]!;
  return { method: preset[0], quality: preset[1] };
}

/* -------------------------------------------------------------------------- */
/* Encoder notes                                                               */
/* -------------------------------------------------------------------------- */

/** The caps note chip beside each row of the encoder list (comp 02b). */
export const ENCODER_NOTE: Readonly<Record<EncoderId, string>> = {
  identity: 'Original',
  avif: 'Recommended',
  webp: 'Wide support',
  mozjpeg: 'Classic',
  jxl: 'Beta',
  oxipng: 'Lossless',
  qoi: 'Lossless',
  'browser-jpeg': 'Browser',
  'browser-png': 'Browser',
  'browser-webp': 'Browser',
};

export function encoderNote(id: EncoderId): string {
  return ENCODER_NOTE[id];
}

/** Encoders with something worth putting in the advanced drawer. */
export function hasAdvanced(id: EncoderId): boolean {
  return id === 'avif' || id === 'jxl' || id === 'webp' || id === 'mozjpeg' || id === 'oxipng';
}

/* -------------------------------------------------------------------------- */
/* Primary knob                                                                */
/* -------------------------------------------------------------------------- */

export interface PrimaryKnob {
  /** `none` ⇒ the toolbar's quality cell shows only {@link PrimaryKnob.note}. */
  kind: 'quality' | 'effort' | 'none';
  /** Mono caps label: `Quality`, `Effort`. Empty for `none`. */
  label: string;
  value: number;
  /** What the 17px mono readout prints. */
  valueText: string;
  min: number;
  max: number;
  step: number;
  /** Labels under the rail — `0 25 50 75 100` for quality. */
  ticks: readonly number[];
  /** True when the encoder is pinned (lossless AVIF/JXL) or has no knob. */
  disabled: boolean;
  /** Caps aside shown next to the label, e.g. `Lossless`. */
  note?: string;
  /** Spoken value for assistive tech. */
  ariaValueText: string;
  /** Produce the next settings for a slider value. Identity when disabled. */
  apply(next: number): SideSettings;
}

const QUALITY_TICKS: readonly number[] = [0, 25, 50, 75, 100];

/**
 * The one control the 108px toolbar gives the current encoder.
 *
 * Special cases, all inherited from the panels this replaces:
 * - lossless AVIF / JPEG XL pin quality at 100, so the slider is shown at 100
 *   and locked — the drawer's Lossless checkbox is what releases it;
 * - lossless WebP swaps quality for the 0–9 libwebp preset ladder;
 * - OxiPNG's headline dial is effort (`level`), not quality;
 * - the canvas encoders take 0–1, but the UI is always 0–100.
 */
export function primaryKnob(settings: SideSettings): PrimaryKnob {
  switch (settings.encoderId) {
    case 'mozjpeg': {
      const options = settings.encoderOptions;
      return quality(settings, options.quality, (next) =>
        withEncoderOptions(settings, { ...options, quality: next }),
      );
    }

    case 'avif': {
      const options = settings.encoderOptions;
      const lossless = isAvifLossless(options);
      return {
        ...quality(settings, options.quality, (next) =>
          withEncoderOptions(settings, { ...options, quality: next }),
        ),
        disabled: lossless,
        note: lossless ? 'Lossless' : undefined,
      };
    }

    case 'jxl': {
      const options = settings.encoderOptions;
      const lossless = isJxlLossless(options);
      const range = ENCODER_QUALITY_RANGE.jxl;
      return {
        ...quality(settings, options.quality, (next) =>
          withEncoderOptions(settings, { ...options, quality: next }),
        ),
        step: range?.step ?? 0.1,
        valueText: formatQuality(options.quality, range?.step ?? 0.1),
        disabled: lossless,
        note: lossless ? 'Lossless' : undefined,
      };
    }

    case 'webp': {
      const options = settings.encoderOptions;
      if (isWebpLossless(options)) {
        const preset = webpLosslessPreset(options);
        return {
          kind: 'effort',
          label: 'Effort',
          value: preset,
          valueText: String(preset),
          min: 0,
          max: 9,
          step: 1,
          ticks: [0, 3, 6, 9],
          disabled: false,
          note: 'Lossless',
          ariaValueText: `effort ${preset} of 9`,
          apply: (next) =>
            withEncoderOptions(settings, { ...options, ...webpLosslessPresetValues(next) }),
        };
      }
      return quality(settings, options.quality, (next) =>
        withEncoderOptions(settings, { ...options, quality: next }),
      );
    }

    case 'oxipng': {
      const options = settings.encoderOptions;
      return {
        kind: 'effort',
        label: 'Effort',
        value: options.level,
        valueText: String(options.level),
        min: 0,
        max: 6,
        step: 1,
        ticks: [0, 2, 4, 6],
        disabled: false,
        ariaValueText: `effort level ${options.level} of 6`,
        apply: (next) => withEncoderOptions(settings, { ...options, level: next }),
      };
    }

    case 'browser-jpeg':
    case 'browser-webp': {
      // `canvas.toBlob` takes 0–1; the slider is always the familiar 0–100.
      const options = settings.encoderOptions;
      const shown = Math.round(options.quality * 100);
      return {
        kind: 'quality',
        label: 'Quality',
        value: shown,
        valueText: String(shown),
        min: 0,
        max: 100,
        step: 1,
        ticks: QUALITY_TICKS,
        disabled: false,
        ariaValueText: `quality ${shown} of 100`,
        apply: (next) => withEncoderOptions(settings, { ...options, quality: next / 100 }),
      };
    }

    case 'qoi':
      return none(settings, 'Lossless · nothing to tune');

    case 'browser-png':
      return none(settings, "The browser's own PNG encoder · nothing to tune");

    default:
      return none(settings);
  }
}

function quality(
  settings: SideSettings,
  value: number,
  apply: (next: number) => SideSettings,
): PrimaryKnob {
  return {
    kind: 'quality',
    label: 'Quality',
    value,
    valueText: formatQuality(value, 1),
    min: 0,
    max: 100,
    step: 1,
    ticks: QUALITY_TICKS,
    disabled: false,
    ariaValueText: `quality ${Math.round(value)} of 100`,
    apply,
  };
}

function none(settings: SideSettings, note?: string): PrimaryKnob {
  return {
    kind: 'none',
    label: '',
    value: 0,
    valueText: '',
    min: 0,
    max: 100,
    step: 1,
    ticks: [],
    disabled: true,
    note,
    ariaValueText: '',
    apply: () => settings,
  };
}
