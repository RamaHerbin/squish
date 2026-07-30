import { describe, expect, it } from 'vitest';

import { DEFAULT_PDF_SETTINGS } from '../contracts';
import type { PdfImageInfo } from '../contracts';

import { imageSkipReason, resampleTarget } from './plan';

/** The base eligible image: 8-bit Flate DeviceRGB, well above the byte floor. */
const img = (over: Partial<PdfImageInfo> = {}): PdfImageInfo => ({
  ref: '1 0 R',
  pageIndices: [0],
  width: 100,
  height: 100,
  filter: 'FlateDecode',
  colorSpace: '/DeviceRGB',
  bitsPerComponent: 8,
  hasSMask: false,
  isMask: false,
  hasCustomDecode: false,
  srcBytes: 10_000,
  ...over,
});

describe('imageSkipReason', () => {
  it('skips a mask before any other reason', () => {
    // isMask wins even when the image is also CMYK.
    expect(imageSkipReason(img({ isMask: true, colorSpace: '/DeviceCMYK' }), DEFAULT_PDF_SETTINGS)).toBe(
      'mask',
    );
  });

  it('skips CMYK', () => {
    expect(imageSkipReason(img({ colorSpace: '/DeviceCMYK' }), DEFAULT_PDF_SETTINGS)).toBe('cmyk');
  });

  it('skips a filter it has no decoder for', () => {
    expect(imageSkipReason(img({ filter: 'unknown' }), DEFAULT_PDF_SETTINGS)).toBe('no-decoder');
    expect(imageSkipReason(img({ filter: 'JPXDecode' }), DEFAULT_PDF_SETTINGS)).toBe('no-decoder');
  });

  it('skips Flate when the JPEG re-encode is turned off', () => {
    expect(
      imageSkipReason(img({ filter: 'FlateDecode' }), { ...DEFAULT_PDF_SETTINGS, flateToJpeg: false }),
    ).toBe('no-decoder');
  });

  it('skips non-8-bit samples as a colour-space reason', () => {
    expect(imageSkipReason(img({ bitsPerComponent: 16 }), DEFAULT_PDF_SETTINGS)).toBe('colorspace');
  });

  it('skips colour spaces other than the two device families', () => {
    expect(imageSkipReason(img({ colorSpace: '/Indexed' }), DEFAULT_PDF_SETTINGS)).toBe('colorspace');
    expect(imageSkipReason(img({ colorSpace: '/ICCBased' }), DEFAULT_PDF_SETTINGS)).toBe('colorspace');
  });

  it('skips an image whose /Decode remaps samples', () => {
    // No decode path applies /Decode and replaceImageStream drops it, so an
    // inverted grayscale plane would come back inverted.
    expect(imageSkipReason(img({ hasCustomDecode: true }), DEFAULT_PDF_SETTINGS)).toBe(
      'colorspace',
    );
  });

  it('skips images below the byte floor', () => {
    // PDF_MIN_IMAGE_BYTES is 4096; 100 is far below.
    expect(imageSkipReason(img({ srcBytes: 100 }), DEFAULT_PDF_SETTINGS)).toBe('too-small');
  });

  it('accepts an eligible Flate DeviceRGB image', () => {
    expect(imageSkipReason(img(), DEFAULT_PDF_SETTINGS)).toBeUndefined();
  });

  it('accepts an eligible DCTDecode image', () => {
    expect(imageSkipReason(img({ filter: 'DCTDecode' }), DEFAULT_PDF_SETTINGS)).toBeUndefined();
  });

  it('does not treat a soft mask as a skip reason', () => {
    expect(imageSkipReason(img({ hasSMask: true }), DEFAULT_PDF_SETTINGS)).toBeUndefined();
  });

  it('reports CMYK before no-decoder for a CMYK JPX image', () => {
    // Rule 2 (cmyk) precedes rule 3 (no-decoder).
    expect(
      imageSkipReason(img({ colorSpace: '/DeviceCMYK', filter: 'JPXDecode' }), DEFAULT_PDF_SETTINGS),
    ).toBe('cmyk');
  });
});

describe('resampleTarget', () => {
  it('scales a placed image down to the DPI target', () => {
    // 1000x500 at 300 DPI, target 150 → scale 0.5 → 500x250.
    expect(
      resampleTarget(img({ width: 1000, height: 500, effectiveDpi: 300 }), {
        ...DEFAULT_PDF_SETTINGS,
        targetDpi: 150,
      }),
    ).toEqual({ width: 500, height: 250 });
  });

  it('leaves a placed image alone at or below the DPI target', () => {
    expect(
      resampleTarget(img({ width: 1000, height: 500, effectiveDpi: 150 }), {
        ...DEFAULT_PDF_SETTINGS,
        targetDpi: 150,
      }),
    ).toBeNull();
  });

  it('ignores maxPixels for a placed image when targetDpi is null', () => {
    // effectiveDpi is set, so the DPI regime governs and the pixel cap must not apply.
    expect(
      resampleTarget(img({ width: 1000, height: 500, effectiveDpi: 300 }), {
        ...DEFAULT_PDF_SETTINGS,
        targetDpi: null,
        maxPixels: 10,
      }),
    ).toBeNull();
  });

  it('caps an unplaced image by its longest edge', () => {
    // No effectiveDpi, 4800x2400, cap 2400 → scale 0.5 → 2400x1200.
    expect(
      resampleTarget(img({ width: 4800, height: 2400 }), { ...DEFAULT_PDF_SETTINGS, maxPixels: 2400 }),
    ).toEqual({ width: 2400, height: 1200 });
  });

  it('leaves an unplaced image alone when both the DPI target and the cap are cleared', () => {
    // What the rail's "Keep" segment sends: no DPI target *and* no fallback cap,
    // so an image the walker could not place is genuinely kept at its stored size.
    expect(
      resampleTarget(img({ width: 4800, height: 2400 }), {
        ...DEFAULT_PDF_SETTINGS,
        targetDpi: null,
        maxPixels: null,
      }),
    ).toBeNull();
  });

  it('leaves an unplaced image alone under the pixel cap', () => {
    expect(
      resampleTarget(img({ width: 1000, height: 800 }), { ...DEFAULT_PDF_SETTINGS, maxPixels: 2400 }),
    ).toBeNull();
  });

  it('rounds fractional targets and clamps to at least one pixel', () => {
    // 3x1 at 300 DPI, target 150 → scale 0.5 → 1.5→2 across, 0.5→1 down.
    expect(
      resampleTarget(img({ width: 3, height: 1, effectiveDpi: 300 }), {
        ...DEFAULT_PDF_SETTINGS,
        targetDpi: 150,
      }),
    ).toEqual({ width: 2, height: 1 });
  });

  it('returns null when rounding reproduces the native size', () => {
    // 1x1 at 300 DPI, target 150 → 0.5 rounds back to 1x1 → no-op.
    expect(
      resampleTarget(img({ width: 1, height: 1, effectiveDpi: 300 }), {
        ...DEFAULT_PDF_SETTINGS,
        targetDpi: 150,
      }),
    ).toBeNull();
  });
});
