import { describe, expect, it } from 'vitest';

import {
  effectiveDpi,
  IDENTITY,
  multiply,
  tokenize,
  unitSquareExtent,
  walkContentStream,
  type Matrix,
  type XObjectResolver,
} from './placement';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A resolver where every listed name is an image and nothing else exists. */
const images =
  (...names: string[]): XObjectResolver =>
  (name) =>
    names.includes(name) ? { kind: 'image' } : undefined;

describe('matrix maths', () => {
  it('concatenates in PDF order — the new matrix applies first', () => {
    const scale: Matrix = [2, 0, 0, 2, 0, 0];
    const translate: Matrix = [1, 0, 0, 1, 10, 20];
    // `2 0 0 2 0 0 cm` then `1 0 0 1 10 20 cm` means scale, then translate in
    // the already-scaled space, so the offset is scaled too.
    expect(multiply(translate, scale)).toEqual([2, 0, 0, 2, 20, 40]);
  });

  it('leaves a matrix alone when multiplied by the identity', () => {
    const m: Matrix = [3, 1, -1, 3, 7, 9];
    expect(multiply(IDENTITY, m)).toEqual(m);
    expect(multiply(m, IDENTITY)).toEqual(m);
  });

  it('measures the unit square through a rotation', () => {
    // 90 degrees: the unit square is still 1x1, just turned.
    const rotated: Matrix = [0, 1, -1, 0, 0, 0];
    const extent = unitSquareExtent(rotated);
    expect(extent.width).toBeCloseTo(1, 10);
    expect(extent.height).toBeCloseTo(1, 10);
  });

  it('measures a rotated *and* scaled placement by edge length, not by a and d', () => {
    // A naive reading of `a` and `d` would report 0x0 here.
    const rotatedScale: Matrix = [0, 200, -100, 0, 0, 0];
    const extent = unitSquareExtent(rotatedScale);
    expect(extent.width).toBeCloseTo(200, 10);
    expect(extent.height).toBeCloseTo(100, 10);
  });
});

describe('effectiveDpi', () => {
  it('matches the hand-checked probe: 1600x1200 in a 515x386pt box is 224 DPI', () => {
    const ctm: Matrix = [515, 0, 0, 386, 40, 400];
    // Across: 1600*72/515 = 223.69. Down: 1200*72/386 = 223.83. The higher one
    // wins, so the narrower axis is never softened.
    expect(effectiveDpi(ctm, 1600, 1200)).toBeCloseTo(223.83, 1);
  });

  it('reports 72 DPI when one pixel is one point', () => {
    const ctm: Matrix = [100, 0, 0, 50, 0, 0];
    expect(effectiveDpi(ctm, 100, 50)).toBeCloseTo(72, 10);
  });

  it('takes the higher axis, so downsampling never softens the other one', () => {
    // 300 DPI across, 72 DPI down. Resampling to 72 would destroy the width.
    const ctm: Matrix = [72, 0, 0, 72, 0, 0];
    expect(effectiveDpi(ctm, 300, 72)).toBeCloseTo(300, 10);
  });

  it('returns 0 for a degenerate placement rather than dividing by zero', () => {
    expect(effectiveDpi([0, 0, 0, 0, 0, 0], 100, 100)).toBe(0);
  });
});

describe('tokenize', () => {
  it('separates numbers, names and operators', () => {
    expect(tokenize(bytes('1 0 0 1 40 400 cm'))).toEqual([
      { kind: 'number', value: 1 },
      { kind: 'number', value: 0 },
      { kind: 'number', value: 0 },
      { kind: 'number', value: 1 },
      { kind: 'number', value: 40 },
      { kind: 'number', value: 400 },
      { kind: 'operator', value: 'cm' },
    ]);
  });

  it('reads signed and bare-decimal numbers', () => {
    const tokens = tokenize(bytes('-1.5 .25 +3 0.0'));
    expect(tokens.map((t) => (t.kind === 'number' ? t.value : t.kind))).toEqual([
      -1.5, 0.25, 3, 0,
    ]);
  });

  it('does not read an operator out of a literal string', () => {
    // `Do` inside the string must not produce a Do operator.
    const tokens = tokenize(bytes('(Do Q q) Tj'));
    expect(tokens).toEqual([{ kind: 'other' }, { kind: 'operator', value: 'Tj' }]);
  });

  it('handles balanced and escaped parens inside a string', () => {
    const tokens = tokenize(bytes('(a (nested) b \\) c) Tj'));
    expect(tokens).toEqual([{ kind: 'other' }, { kind: 'operator', value: 'Tj' }]);
  });

  it('skips hex strings and dictionaries whole', () => {
    expect(tokenize(bytes('<414243> Tj'))).toEqual([
      { kind: 'other' },
      { kind: 'operator', value: 'Tj' },
    ]);
    expect(tokenize(bytes('<</Type /Foo>> BDC'))).toEqual([
      { kind: 'other' },
      { kind: 'operator', value: 'BDC' },
    ]);
  });

  it('skips comments', () => {
    expect(tokenize(bytes('% Do not read this\n1 w'))).toEqual([
      { kind: 'number', value: 1 },
      { kind: 'operator', value: 'w' },
    ]);
  });

  it('decodes #xx escapes in names', () => {
    const tokens = tokenize(bytes('/Im#20one Do'));
    expect(tokens[0]).toEqual({ kind: 'name', value: 'Im one' });
  });

  it('steps over inline image data instead of lexing it as operators', () => {
    // The binary payload contains bytes that spell `Do` and `Q`.
    const stream = 'BI /W 2 /H 2 ID Do Q qq EI /Real Do';
    const tokens = tokenize(bytes(stream));
    const operators = tokens.filter((t) => t.kind === 'operator').map((t) => t.value);
    expect(operators).toEqual(['BI', 'Do']);
    expect(tokens.at(-2)).toEqual({ kind: 'name', value: 'Real' });
  });
});

describe('walkContentStream', () => {
  it('finds an image with the matrix in force, matching the probe stream', () => {
    const stream = `q
1 0 0 1 40 400 cm
1 0 0 1 0 0 cm
515 0 0 386 0 0 cm
1 0 0 1 0 0 cm
/Image-1 Do
Q`;
    const found = walkContentStream(bytes(stream), images('Image-1'));
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe('Image-1');
    expect(effectiveDpi(found[0]?.ctm ?? IDENTITY, 1600, 1200)).toBeCloseTo(223.83, 1);
  });

  it('restores the matrix on Q, so a later draw is not scaled by an earlier one', () => {
    const stream = `q 500 0 0 500 0 0 cm /A Do Q
q 100 0 0 100 0 0 cm /A Do Q`;
    const found = walkContentStream(bytes(stream), images('A'));
    expect(found).toHaveLength(2);
    expect(unitSquareExtent(found[0]?.ctm ?? IDENTITY).width).toBeCloseTo(500, 10);
    expect(unitSquareExtent(found[1]?.ctm ?? IDENTITY).width).toBeCloseTo(100, 10);
  });

  it('accumulates nested cm operators', () => {
    const stream = 'q 2 0 0 2 0 0 cm q 50 0 0 50 0 0 cm /A Do Q Q';
    const found = walkContentStream(bytes(stream), images('A'));
    expect(unitSquareExtent(found[0]?.ctm ?? IDENTITY).width).toBeCloseTo(100, 10);
  });

  it('survives an unbalanced Q without throwing', () => {
    const found = walkContentStream(bytes('Q Q 10 0 0 10 0 0 cm /A Do'), images('A'));
    expect(unitSquareExtent(found[0]?.ctm ?? IDENTITY).width).toBeCloseTo(10, 10);
  });

  it('ignores a Do for a name that resolves to nothing', () => {
    expect(walkContentStream(bytes('/Missing Do'), images('A'))).toEqual([]);
  });

  it('ignores a malformed cm and keeps the previous matrix', () => {
    // Five operands, not six.
    const found = walkContentStream(bytes('10 0 0 10 0 cm /A Do'), images('A'));
    expect(found[0]?.ctm).toEqual(IDENTITY);
  });

  it('recurses into a form XObject and composes its /Matrix', () => {
    const resolve: XObjectResolver = (name) => {
      if (name === 'Form') {
        return {
          kind: 'form',
          contents: bytes('/Inner Do'),
          matrix: [0.5, 0, 0, 0.5, 0, 0],
          resolve: images('Inner'),
        };
      }
      return undefined;
    };
    const found = walkContentStream(bytes('q 200 0 0 200 0 0 cm /Form Do Q'), resolve);
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe('Inner');
    // 200 scaled by the form's own 0.5.
    expect(unitSquareExtent(found[0]?.ctm ?? IDENTITY).width).toBeCloseTo(100, 10);
  });

  it('stops rather than hanging when forms reference each other in a cycle', () => {
    const cyclic: XObjectResolver = (name) =>
      name === 'Loop'
        ? { kind: 'form', contents: bytes('/Loop Do'), resolve: cyclic }
        : undefined;
    expect(walkContentStream(bytes('/Loop Do'), cyclic)).toEqual([]);
  });

  it('reports every draw of a repeated image, so the caller can take the largest', () => {
    const stream = `q 100 0 0 100 0 0 cm /Logo Do Q
q 600 0 0 600 0 0 cm /Logo Do Q`;
    const found = walkContentStream(bytes(stream), images('Logo'));
    const widths = found.map((p) => unitSquareExtent(p.ctm).width);
    expect(widths.map(Math.round)).toEqual([100, 600]);
  });
});
