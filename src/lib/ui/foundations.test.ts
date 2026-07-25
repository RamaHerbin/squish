/**
 * Foundations: the pure half. Covers the accent palette map used by every
 * primitive and the helpers exported from `contracts/pinch.ts`.
 *
 * Nothing here touches the DOM — the components themselves are exercised by
 * the screens that consume them.
 */

import { describe, expect, it } from 'vitest';

import {
  APP_VIEWS,
  DEFAULT_APP_SETTINGS,
  ENCODER_IDS,
  MATRIX_ENCODERS,
  MATRIX_QUALITY_STEPS,
  THRESHOLDS,
  createDefaultAppSettings,
  isAppView,
  savingsPct,
  verdictFor,
} from '../contracts';

import {
  ACCENT_FILL,
  ACCENT_NAMES,
  ACCENT_TEXT,
  ENCODER_ACCENT,
  accentFill,
  accentText,
  isAccentName,
} from './types';

describe('accent palette', () => {
  it('maps every accent name to a token, never a raw hex', () => {
    for (const name of ACCENT_NAMES) {
      expect(ACCENT_FILL[name]).toMatch(/^var\(--/);
      expect(ACCENT_TEXT[name]).toMatch(/^var\(--/);
    }
  });

  it('uses the darkened twin for text on paper', () => {
    expect(ACCENT_TEXT.green).toBe('var(--accent-green-dark)');
    expect(ACCENT_TEXT.purple).toBe('var(--accent-purple-dark)');
    expect(ACCENT_TEXT.yellow).toBe('var(--accent-yellow-dark)');
    expect(ACCENT_FILL.green).toBe('var(--accent-green)');
  });

  it('passes unknown colours straight through', () => {
    expect(isAccentName('blue')).toBe(true);
    expect(isAccentName('#ff0000')).toBe(false);
    expect(accentFill('#ff0000')).toBe('#ff0000');
    expect(accentText('currentColor')).toBe('currentColor');
    expect(accentFill('blue')).toBe('var(--accent-blue)');
  });

  it('gives every encoder an accent', () => {
    for (const id of ENCODER_IDS) {
      expect(ACCENT_NAMES).toContain(ENCODER_ACCENT[id]);
    }
  });
});

describe('verdictFor', () => {
  it('reports unmeasurable scores honestly', () => {
    expect(verdictFor(null)).toEqual({ label: 'Unmeasured', tone: 'ok' });
    expect(verdictFor(Number.NaN).label).toBe('Unmeasured');
  });

  it('reads the comp numbers the way the comp labels them', () => {
    expect(verdictFor(1).label).toBe('Lossless');
    expect(verdictFor(0.999).label).toBe('Overkill');
    expect(verdictFor(0.994).label).toBe('Excellent');
    expect(verdictFor(0.991).label).toBe('Good');
    expect(verdictFor(0.961).label).toBe('Soft');
    expect(verdictFor(0.9).label).toBe('Visible loss');
  });

  it('only warns below the soft threshold', () => {
    expect(verdictFor(THRESHOLDS.soft).tone).toBe('ok');
    expect(verdictFor(THRESHOLDS.soft - 0.001).tone).toBe('warn');
  });
});

describe('savingsPct', () => {
  it('rounds to whole percent', () => {
    expect(savingsPct(2_920_000, 390_000)).toBe(87);
    expect(savingsPct(100, 65)).toBe(35);
  });

  it('goes negative when the encode grew, and never divides by zero', () => {
    expect(savingsPct(100, 150)).toBe(-50);
    expect(savingsPct(0, 100)).toBe(0);
  });
});

describe('app views & settings', () => {
  it('recognises exactly the five screens', () => {
    expect(APP_VIEWS).toHaveLength(5);
    for (const view of APP_VIEWS) expect(isAppView(view)).toBe(true);
    expect(isAppView('intro')).toBe(false);
    expect(isAppView(42)).toBe(false);
  });

  it('hands out a fresh settings object every time', () => {
    const a = createDefaultAppSettings();
    const b = createDefaultAppSettings();
    expect(a).toEqual(DEFAULT_APP_SETTINGS);
    expect(a).not.toBe(b);
    a.workerThreads = 16;
    expect(DEFAULT_APP_SETTINGS.workerThreads).not.toBe(16);
  });
});

describe('matrix sweep shape', () => {
  it('is 5 encoders × 4 quality steps, as drawn', () => {
    expect(MATRIX_QUALITY_STEPS).toEqual([30, 50, 70, 90]);
    expect(MATRIX_ENCODERS).toHaveLength(5);
    for (const id of MATRIX_ENCODERS) {
      expect(ENCODER_IDS).toContain(id);
    }
  });
});
