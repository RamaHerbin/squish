/**
 * Presentation helpers for batch mode. Pure functions, no DOM — the view stays
 * markup, and every number in the UI is formatted in exactly one place.
 */

import {
  ENCODER_QUALITY_RANGE,
  type EncoderId,
  type EncoderRegistry,
  type ResizeState,
  type SideSettings,
} from '../contracts';

/* -------------------------------------------------------------------------- */
/* Numbers                                                                     */
/* -------------------------------------------------------------------------- */

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const;

/**
 * File size in SI units, matching what the OS file browser shows.
 * Precision shrinks as the number grows: `948 B`, `12.4 kB`, `1.2 MB`.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }

  const digits = unit === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toFixed(digits)} ${UNITS[unit] ?? 'B'}`;
}

/** Share of the original that was removed, `0.78` for a 78% saving. */
export function savedFraction(srcSize: number, outSize: number | undefined): number | undefined {
  if (outSize === undefined || srcSize <= 0) return undefined;
  return 1 - outSize / srcSize;
}

/** Signed percentage, e.g. `-78%` for a saving, `+4%` when the output grew. */
export function formatSaved(fraction: number | undefined): string {
  if (fraction === undefined) return '';
  const percent = Math.round(fraction * 100);
  if (percent === 0) return '0%';
  return percent > 0 ? `-${percent}%` : `+${Math.abs(percent)}%`;
}

/** `0.32` → `32%`, for progress readouts. */
export function formatPercent(fraction: number): string {
  return `${Math.round(clamp01(fraction) * 100)}%`;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

/** Human names for the encoder `<select>`, mirrored so batch stays standalone. */
export const ENCODER_LABELS: Readonly<Record<EncoderId, string>> = {
  identity: 'Original',
  mozjpeg: 'MozJPEG',
  oxipng: 'OxiPNG',
  webp: 'WebP',
  avif: 'AVIF',
  jxl: 'JPEG XL',
  qoi: 'QOI',
  'browser-jpeg': 'JPEG',
  'browser-png': 'PNG',
  'browser-webp': 'WebP',
};

export function encoderLabel(id: EncoderId, registry?: EncoderRegistry): string {
  return registry?.[id]?.label ?? ENCODER_LABELS[id];
}

/**
 * The encoder's primary quality value, normalised to the 0–100 the slider
 * shows. `undefined` for encoders without a quality control.
 */
export function qualityOf(settings: SideSettings): number | undefined {
  switch (settings.encoderId) {
    case 'avif':
    case 'jxl':
    case 'webp':
    case 'mozjpeg':
      return settings.encoderOptions.quality;
    case 'browser-jpeg':
    case 'browser-webp':
      return Math.round(settings.encoderOptions.quality * 100);
    default:
      return undefined;
  }
}

export function hasQuality(id: EncoderId): boolean {
  return ENCODER_QUALITY_RANGE[id] !== undefined;
}

/** `1200 × 800 · contain` — `undefined` when resizing is off. */
export function formatResize(resize: ResizeState): string | undefined {
  if (!resize.enabled) return undefined;
  const dimensions = `${Math.round(resize.width)} x ${Math.round(resize.height)}`;
  return resize.fitMethod === 'contain' ? `${dimensions} contain` : dimensions;
}

export interface SettingsFact {
  label: string;
  value: string;
}

/** The settings bar's contents: what every file in this batch will get. */
export function settingsFacts(
  settings: SideSettings,
  registry?: EncoderRegistry,
): SettingsFact[] {
  const facts: SettingsFact[] = [
    { label: 'Format', value: encoderLabel(settings.encoderId, registry) },
  ];

  const quality = qualityOf(settings);
  if (quality !== undefined) {
    facts.push({ label: 'Quality', value: String(Math.round(quality)) });
  }
  if (settings.encoderId === 'oxipng') {
    facts.push({ label: 'Effort', value: `level ${settings.encoderOptions.level}` });
  }

  const resize = formatResize(settings.processorState.resize);
  facts.push({ label: 'Resize', value: resize ?? 'Original size' });

  return facts;
}

/* -------------------------------------------------------------------------- */
/* Paths                                                                       */
/* -------------------------------------------------------------------------- */

/** Split `a/b/photo.jpg` into the dimmed folder and the emphasised filename. */
export function splitPath(path: string): { folder: string; name: string } {
  const index = path.lastIndexOf('/');
  if (index === -1) return { folder: '', name: path };
  return { folder: path.slice(0, index + 1), name: path.slice(index + 1) };
}
