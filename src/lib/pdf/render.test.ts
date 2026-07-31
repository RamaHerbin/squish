import { describe, expect, it } from 'vitest';

import {
  MAX_RENDER_SCALE,
  MIN_RENDER_SCALE,
  clampPageIndex,
  fitScale,
  pdfjsAssetUrls,
} from './render';

/**
 * Only the pure half of `render.ts` is reachable from vitest. Rasterising needs
 * pdf.js, a worker and a canvas, none of which exist here — the renderer proper
 * is covered by `e2e/pdf.smoke.spec.ts`, which reads pixels back out of the real
 * canvas and fails if pdf.js quietly substitutes its main-thread fake worker.
 */

describe('fitScale', () => {
  it('fits a page wider than the box by its width', () => {
    // 200x100 into 100x100: width is the binding constraint, 100/200 = 0.5.
    expect(fitScale({ width: 200, height: 100 }, { width: 100, height: 100 })).toBe(0.5);
  });

  it('fits a page taller than the box by its height', () => {
    expect(fitScale({ width: 100, height: 200 }, { width: 100, height: 100 })).toBe(0.5);
  });

  it('takes the smaller of the two ratios, not the larger', () => {
    // The whole point: 4 across would fit, 2 down would not, so 2 wins.
    expect(fitScale({ width: 100, height: 100 }, { width: 400, height: 200 })).toBe(2);
  });

  it('honours an explicit cap', () => {
    expect(fitScale({ width: 10, height: 10 }, { width: 1000, height: 1000 }, 2)).toBe(2);
  });

  it('does not apply the cap below it', () => {
    expect(fitScale({ width: 100, height: 100 }, { width: 150, height: 150 }, 4)).toBe(1.5);
  });

  it('caps at MAX_RENDER_SCALE by default', () => {
    // A page a thousand times smaller than the box would otherwise ask for a
    // canvas no browser will allocate.
    expect(fitScale({ width: 1, height: 1 }, { width: 1000, height: 1000 })).toBe(MAX_RENDER_SCALE);
  });

  it('falls back to the default cap when handed a nonsense one', () => {
    // A caller computing its own cap can arrive at 0 or NaN; taking it literally
    // would render a zero-pixel page.
    const page = { width: 1, height: 1 };
    const box = { width: 1000, height: 1000 };
    expect(fitScale(page, box, 0)).toBe(MAX_RENDER_SCALE);
    expect(fitScale(page, box, -2)).toBe(MAX_RENDER_SCALE);
    expect(fitScale(page, box, Number.NaN)).toBe(MAX_RENDER_SCALE);
  });

  it('floors a page far too big for its box', () => {
    // 10000pt into 1px is 0.0001; the floor is what keeps the canvas non-empty.
    expect(fitScale({ width: 10_000, height: 10_000 }, { width: 1, height: 1 })).toBe(
      MIN_RENDER_SCALE,
    );
  });

  it('returns the floor for a zero box', () => {
    // The stage measures zero for one frame on mount. Scale 0 means a 0x0
    // canvas, and `getImageData` on one throws.
    expect(fitScale({ width: 612, height: 792 }, { width: 0, height: 0 })).toBe(MIN_RENDER_SCALE);
  });

  it('returns the floor for a negative box', () => {
    expect(fitScale({ width: 612, height: 792 }, { width: -100, height: -100 })).toBe(
      MIN_RENDER_SCALE,
    );
  });

  it('returns the floor for a degenerate page', () => {
    // A malformed /MediaBox can be zero-sized; naive division gives Infinity.
    expect(fitScale({ width: 0, height: 0 }, { width: 800, height: 600 })).toBe(MIN_RENDER_SCALE);
    expect(fitScale({ width: Number.NaN, height: 792 }, { width: 800, height: 600 })).toBe(
      MIN_RENDER_SCALE,
    );
  });

  it('never returns a scale outside the two limits', () => {
    const boxes = [0, 1, 37, 1600, 100_000];
    for (const width of boxes) {
      for (const height of boxes) {
        const scale = fitScale({ width: 612, height: 792 }, { width, height });
        expect(scale).toBeGreaterThanOrEqual(MIN_RENDER_SCALE);
        expect(scale).toBeLessThanOrEqual(MAX_RENDER_SCALE);
      }
    }
  });
});

describe('pdfjsAssetUrls', () => {
  /**
   * These strings are the app's half of a three-way contract with
   * `vite.config.ts` (which copies the files to `assets/pdfjs/<version>/` and
   * serves that path in dev) and `shell/sw.ts` (which runtime-caches
   * `/assets/pdfjs/`). Nothing else can catch a drift: every fetch off these
   * URLs happens inside pdf.js, under `ignoreErrors`, and the e2e fixture is
   * Latin text with DCT images, so it asks for neither directory.
   */
  it('builds the versioned prefix the build actually writes to', () => {
    expect(pdfjsAssetUrls('6.2.108')).toEqual({
      cMapUrl: '/assets/pdfjs/6.2.108/cmaps/',
      wasmUrl: '/assets/pdfjs/6.2.108/wasm/',
    });
  });

  it('keeps the trailing slash pdf.js validates for', () => {
    // `getFactoryUrlProp` throws unless the string ends in `/` — it concatenates
    // a bare filename onto it.
    const { cMapUrl, wasmUrl } = pdfjsAssetUrls('1.2.3');
    expect(cMapUrl.endsWith('/')).toBe(true);
    expect(wasmUrl.endsWith('/')).toBe(true);
  });

  it('stays under /assets/, where a miss is a 404 and not an index.html', () => {
    // `vercel.json` rewrites `/((?!assets/).*)` to the shell. Anywhere else, a
    // missing CMap comes back 200 `text/html` and gets parsed as CMap data.
    for (const url of Object.values(pdfjsAssetUrls('9.9.9'))) {
      expect(url.startsWith('/assets/')).toBe(true);
    }
  });
});

describe('clampPageIndex', () => {
  it('leaves an index inside the document alone', () => {
    expect(clampPageIndex(1, 3)).toBe(1);
  });

  it('clamps to the first page below the range', () => {
    expect(clampPageIndex(-1, 3)).toBe(0);
    expect(clampPageIndex(-99, 3)).toBe(0);
  });

  it('clamps to the last page above the range', () => {
    expect(clampPageIndex(5, 3)).toBe(2);
  });

  it('accepts both ends of the range', () => {
    expect(clampPageIndex(0, 3)).toBe(0);
    expect(clampPageIndex(2, 3)).toBe(2);
  });

  it('truncates a fractional index onto a real page', () => {
    expect(clampPageIndex(1.9, 3)).toBe(1);
    expect(clampPageIndex(-0.5, 3)).toBe(0);
  });

  it('returns 0 for a document with no pages', () => {
    // [0, 0) is empty, so there is no correct index; 0 is the only answer that
    // does not hand pdf.js a negative page number.
    expect(clampPageIndex(0, 0)).toBe(0);
    expect(clampPageIndex(3, 0)).toBe(0);
    expect(clampPageIndex(0, -1)).toBe(0);
  });

  it('collapses a non-finite index or page count to the first page', () => {
    // Infinity is *not* treated as "past the end" — it is treated as nonsense,
    // which is the documented rule and the one that cannot surprise a caller.
    expect(clampPageIndex(Number.NaN, 3)).toBe(0);
    expect(clampPageIndex(Number.POSITIVE_INFINITY, 3)).toBe(0);
    expect(clampPageIndex(1, Number.NaN)).toBe(0);
    expect(clampPageIndex(1, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
