/**
 * Where an image is actually drawn, and therefore at what resolution.
 *
 * Knowing an image is 4000px wide says nothing about whether it is oversized:
 * a 4000px image in a full-page frame is fine, the same image in a thumbnail is
 * eight times more data than the page can show. The only way to tell them apart
 * is to walk the page's content stream, track the current transformation matrix
 * through `q`/`Q`/`cm`, and read it off at each `Do`.
 *
 * pdf-lib parses the object graph but not content streams, so this is a small
 * hand-written lexer plus a graphics-state stack. It is deliberately pure —
 * bytes in, placements out, no pdf-lib types — which is what makes it the most
 * thoroughly testable part of the feature.
 *
 * Form XObjects recurse: they carry their own `/Matrix` and their own
 * `/Resources`, so an image can sit several frames deep. Recursion is bounded
 * by {@link MAX_FORM_DEPTH} because a malformed file can make forms reference
 * each other in a cycle.
 */

/** `[a b c d e f]`, the PDF transformation matrix. */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** A form referencing itself is malformed but not rare. */
export const MAX_FORM_DEPTH = 8;

/** PDF user space is 1/72 inch, by definition. */
const POINTS_PER_INCH = 72;

/**
 * `m` applied first, then `n` — i.e. `cm` concatenation order.
 *
 * PDF composes row-vector style, so the new matrix goes on the left of the
 * existing CTM: `CTM' = m x CTM`.
 */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

/**
 * The size in points of the unit square once `ctm` has been applied.
 *
 * An image always occupies the unit square in its own space, so this is the
 * image's drawn size. Using the column lengths rather than `a` and `d` directly
 * keeps rotated and skewed placements honest.
 */
export function unitSquareExtent(ctm: Matrix): { width: number; height: number } {
  return {
    width: Math.hypot(ctm[0], ctm[1]),
    height: Math.hypot(ctm[2], ctm[3]),
  };
}

/**
 * Resolution an image of `width` x `height` pixels is displayed at when drawn
 * through `ctm`.
 *
 * Returns the larger of the two axes: downsampling to the smaller one would
 * visibly soften the other.
 */
export function effectiveDpi(ctm: Matrix, width: number, height: number): number {
  const extent = unitSquareExtent(ctm);
  if (extent.width <= 0 || extent.height <= 0) return 0;
  const dpiX = (width * POINTS_PER_INCH) / extent.width;
  const dpiY = (height * POINTS_PER_INCH) / extent.height;
  return Math.max(dpiX, dpiY);
}

/* -------------------------------------------------------------------------- */
/* Lexer                                                                       */
/* -------------------------------------------------------------------------- */

export type Token =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'operator'; readonly value: string }
  /** Strings, dictionaries and arrays are skipped wholesale — no operator this
   *  walk cares about takes one, and stepping over them correctly is what stops
   *  a `(` inside a string from being read as an operator. */
  | { readonly kind: 'other' };

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isRegular(byte: number): boolean {
  return !WHITESPACE.has(byte) && !DELIMITERS.has(byte);
}

/**
 * Tokenise a content stream.
 *
 * Only enough of the grammar to find `q`, `Q`, `cm`, `gs` and `Do` with their
 * operands. Everything structural that could hide a false operator — literal
 * strings, hex strings, inline images — is consumed and reported as `other`.
 */
export function tokenize(bytes: Uint8Array): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < bytes.length) {
    const byte = bytes[i];
    if (byte === undefined) break;

    if (WHITESPACE.has(byte)) {
      i += 1;
      continue;
    }

    // Comment to end of line.
    if (byte === 0x25) {
      while (i < bytes.length && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i += 1;
      continue;
    }

    // Literal string: balanced parens, backslash escapes.
    if (byte === 0x28) {
      i += 1;
      let depth = 1;
      while (i < bytes.length && depth > 0) {
        const c = bytes[i];
        if (c === 0x5c) {
          i += 2;
          continue;
        }
        if (c === 0x28) depth += 1;
        else if (c === 0x29) depth -= 1;
        i += 1;
      }
      tokens.push({ kind: 'other' });
      continue;
    }

    // Hex string, or a dictionary when doubled.
    if (byte === 0x3c) {
      if (bytes[i + 1] === 0x3c) {
        i += 2;
        let depth = 1;
        while (i < bytes.length && depth > 0) {
          if (bytes[i] === 0x3c && bytes[i + 1] === 0x3c) {
            depth += 1;
            i += 2;
            continue;
          }
          if (bytes[i] === 0x3e && bytes[i + 1] === 0x3e) {
            depth -= 1;
            i += 2;
            continue;
          }
          i += 1;
        }
      } else {
        while (i < bytes.length && bytes[i] !== 0x3e) i += 1;
        i += 1;
      }
      tokens.push({ kind: 'other' });
      continue;
    }

    // Array brackets carry no operand this walk needs.
    if (byte === 0x5b || byte === 0x5d || byte === 0x7b || byte === 0x7d || byte === 0x3e) {
      i += 1;
      tokens.push({ kind: 'other' });
      continue;
    }

    // Name.
    if (byte === 0x2f) {
      i += 1;
      const start = i;
      while (i < bytes.length) {
        const c = bytes[i];
        if (c === undefined || !isRegular(c)) break;
        i += 1;
      }
      tokens.push({ kind: 'name', value: decodeName(bytes.subarray(start, i)) });
      continue;
    }

    // Number or operator: one regular-character run.
    const start = i;
    while (i < bytes.length) {
      const c = bytes[i];
      if (c === undefined || !isRegular(c)) break;
      i += 1;
    }
    if (i === start) {
      i += 1;
      continue;
    }
    const text = latin1(bytes.subarray(start, i));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) {
      tokens.push({ kind: 'number', value: Number.parseFloat(text) });
    } else {
      tokens.push({ kind: 'operator', value: text });
      // An inline image runs from BI to EI as raw bytes; skipping to EI keeps
      // its payload from being lexed as operators.
      if (text === 'BI') i = skipInlineImage(bytes, i);
    }
  }

  return tokens;
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** `#xx` escapes are legal inside names and appear in generated files. */
function decodeName(bytes: Uint8Array): string {
  const raw = latin1(bytes);
  if (!raw.includes('#')) return raw;
  return raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** Advance past an inline image's data to just after its `EI`. */
function skipInlineImage(bytes: Uint8Array, from: number): number {
  for (let i = from; i < bytes.length - 1; i += 1) {
    const isEi = bytes[i] === 0x45 && bytes[i + 1] === 0x49;
    if (!isEi) continue;
    const before = bytes[i - 1];
    const after = bytes[i + 2];
    const delimitedBefore = before === undefined || WHITESPACE.has(before);
    const delimitedAfter = after === undefined || WHITESPACE.has(after) || DELIMITERS.has(after);
    if (delimitedBefore && delimitedAfter) return i + 2;
  }
  return bytes.length;
}

/* -------------------------------------------------------------------------- */
/* Walk                                                                        */
/* -------------------------------------------------------------------------- */

/** One `Do` of an image XObject, with the matrix in force at that point. */
export interface Placement {
  /** The `/Name` used in the content stream, resolved by the caller. */
  readonly name: string;
  readonly ctm: Matrix;
  /**
   * The image object's ref (e.g. `"12 0 R"`), when the resolver supplied one.
   * Carried through so a caller can attribute a placement to the right image
   * even when the same `/Name` means different objects in nested form scopes.
   */
  readonly ref?: string;
}

/**
 * Resolves an XObject name to what it is, so the walk can recurse into forms
 * without knowing anything about pdf-lib.
 */
export interface XObjectResolver {
  (name: string):
    | { readonly kind: 'image'; readonly ref?: string }
    | {
        readonly kind: 'form';
        readonly contents: Uint8Array;
        /** The form's own `/Matrix`, if it has one. */
        readonly matrix?: Matrix;
        /** Resolver for the form's own `/Resources`. */
        readonly resolve: XObjectResolver;
      }
    | undefined;
}

/**
 * Every image draw in a content stream, with its effective matrix.
 *
 * The same image can appear many times — a logo on every page, or a tiled
 * background — so callers keep the largest placement, which is the one that
 * dictates how much resolution is actually needed.
 */
export function walkContentStream(
  contents: Uint8Array,
  resolve: XObjectResolver,
  base: Matrix = IDENTITY,
  depth = 0,
): Placement[] {
  if (depth > MAX_FORM_DEPTH) return [];

  const tokens = tokenize(contents);
  const placements: Placement[] = [];
  const stack: Matrix[] = [];
  let ctm = base;
  /** Operands seen since the last operator. */
  let operands: Token[] = [];

  for (const token of tokens) {
    if (token.kind !== 'operator') {
      operands.push(token);
      // Nothing this walk reads takes more than six operands; keeping the tail
      // bounded stops a pathological stream from growing an array forever.
      if (operands.length > 8) operands.shift();
      continue;
    }

    switch (token.value) {
      case 'q':
        stack.push(ctm);
        break;
      case 'Q': {
        const restored = stack.pop();
        if (restored) ctm = restored;
        break;
      }
      case 'cm': {
        const numbers = numericTail(operands, 6);
        if (numbers) ctm = multiply(numbers, ctm);
        break;
      }
      case 'Do': {
        const last = operands[operands.length - 1];
        if (last?.kind !== 'name') break;
        const target = resolve(last.value);
        if (!target) break;
        if (target.kind === 'image') {
          placements.push({ name: last.value, ctm, ref: target.ref });
          break;
        }
        const inner = target.matrix ? multiply(target.matrix, ctm) : ctm;
        placements.push(
          ...walkContentStream(target.contents, target.resolve, inner, depth + 1),
        );
        break;
      }
      default:
        break;
    }

    operands = [];
  }

  return placements;
}

/** The last `count` operands, when they are all numbers. */
function numericTail(operands: readonly Token[], count: number): Matrix | undefined {
  if (operands.length < count) return undefined;
  const tail = operands.slice(-count);
  const values: number[] = [];
  for (const token of tail) {
    if (token.kind !== 'number' || !Number.isFinite(token.value)) return undefined;
    values.push(token.value);
  }
  if (values.length !== 6) return undefined;
  const [a, b, c, d, e, f] = values as [number, number, number, number, number, number];
  return [a, b, c, d, e, f];
}
