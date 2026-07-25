/**
 * Shared prop types and the accent palette map for the editorial primitives.
 *
 * Colours are returned as CSS `var(--…)` strings so a component can drop them
 * straight into a `style` attribute and still inherit any local override.
 * Never inline a hex here — `app.css` owns the values.
 */

import type { EncoderId } from '../contracts';

/* -------------------------------------------------------------------------- */
/* Accents                                                                     */
/* -------------------------------------------------------------------------- */

/** The five accents of the design, plus the two neutral inks. */
export type AccentName = 'blue' | 'red' | 'green' | 'purple' | 'yellow' | 'ink' | 'muted';

export const ACCENT_NAMES: readonly AccentName[] = [
  'blue',
  'red',
  'green',
  'purple',
  'yellow',
  'ink',
  'muted',
];

/** Fill colour — dots, badges, solid chips. Full-strength accent. */
export const ACCENT_FILL: Readonly<Record<AccentName, string>> = {
  blue: 'var(--accent-blue)',
  red: 'var(--accent-red)',
  green: 'var(--accent-green)',
  purple: 'var(--accent-purple)',
  yellow: 'var(--accent-yellow)',
  ink: 'var(--ink)',
  muted: 'var(--muted)',
};

/**
 * Text colour on paper. Green, purple and yellow use their darkened twins —
 * the design does this everywhere a label is coloured rather than filled.
 */
export const ACCENT_TEXT: Readonly<Record<AccentName, string>> = {
  blue: 'var(--accent-blue)',
  red: 'var(--accent-red)',
  green: 'var(--accent-green-dark)',
  purple: 'var(--accent-purple-dark)',
  yellow: 'var(--accent-yellow-dark)',
  ink: 'var(--ink)',
  muted: 'var(--muted)',
};

export function isAccentName(value: string): value is AccentName {
  return (ACCENT_NAMES as readonly string[]).includes(value);
}

/** Accent name → fill colour. Any other string is passed through as a colour. */
export function accentFill(value: string): string {
  return isAccentName(value) ? ACCENT_FILL[value] : value;
}

/** Accent name → text colour. Any other string is passed through as a colour. */
export function accentText(value: string): string {
  return isAccentName(value) ? ACCENT_TEXT[value] : value;
}

/**
 * One accent per encoder, so a codec is the same colour in the matrix, the
 * queue and the encoder list. Matches the comp: MozJPEG red, WebP blue,
 * AVIF purple, JPEG XL yellow, OxiPNG green.
 */
export const ENCODER_ACCENT: Readonly<Record<EncoderId, AccentName>> = {
  mozjpeg: 'red',
  webp: 'blue',
  avif: 'purple',
  jxl: 'yellow',
  oxipng: 'green',
  qoi: 'green',
  'browser-jpeg': 'muted',
  'browser-png': 'muted',
  'browser-webp': 'muted',
  identity: 'ink',
};

/* -------------------------------------------------------------------------- */
/* Control props                                                               */
/* -------------------------------------------------------------------------- */

/** Solid ink, ink outline on paper, or a filled blue call-to-action. */
export type PillVariant = 'solid' | 'outline' | 'accent';

/** Heights straight off the comps: 38 inline, 44 standard, 52 primary. */
export type PillSize = 38 | 44 | 52;

/** Chrome uses Space Mono caps; marketing copy uses Archivo. */
export type ControlFont = 'mono' | 'body';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export type PopoverPlacement =
  | 'bottom-start'
  | 'bottom-end'
  | 'top-start'
  | 'top-end';

/** Paper card with an ink outline, or the inverted ink slab. */
export type CardVariant = 'paper' | 'ink';
