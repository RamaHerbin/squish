/**
 * Read a PDF and describe its embedded images without changing a byte.
 *
 * The heavy lifting is pdf-lib for the object graph and {@link walkContentStream}
 * for "how big is this image actually drawn". This module glues the two: it
 * enumerates every image XObject, walks each page to attribute draws (and their
 * effective DPI) back to those objects, and refuses documents that must not be
 * rewritten (encrypted or signed) up front.
 *
 * Everything here is a pure `ArrayBuffer -> PdfAnalysis` read. No worker, no
 * canvas — the recompression pass (which needs both) is a separate module.
 */

import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
  type PDFPageLeaf,
} from '@cantoo/pdf-lib';

import type { PdfAnalysis, PdfImageFilter, PdfImageInfo, PdfRefusal } from '../contracts';
import { effectiveDpi, walkContentStream, type Matrix, type XObjectResolver } from './placement';

/** Interned name keys, looked up once. `PDFName.of` pools, so this is cheap. */
const KEY = {
  Subtype: PDFName.of('Subtype'),
  Width: PDFName.of('Width'),
  Height: PDFName.of('Height'),
  BitsPerComponent: PDFName.of('BitsPerComponent'),
  Filter: PDFName.of('Filter'),
  ColorSpace: PDFName.of('ColorSpace'),
  SMask: PDFName.of('SMask'),
  ImageMask: PDFName.of('ImageMask'),
  XObject: PDFName.of('XObject'),
  Matrix: PDFName.of('Matrix'),
  Type: PDFName.of('Type'),
  FT: PDFName.of('FT'),
  ByteRange: PDFName.of('ByteRange'),
  SigFlags: PDFName.of('SigFlags'),
} as const;

const KNOWN_FILTERS: ReadonlySet<string> = new Set<PdfImageFilter>([
  'DCTDecode',
  'FlateDecode',
  'JPXDecode',
  'CCITTFaxDecode',
  'JBIG2Decode',
  'LZWDecode',
  'RunLengthDecode',
]);

/**
 * Analyse a PDF. Never throws — a file pdf-lib cannot parse comes back as an
 * `unreadable` refusal, matching how encrypted and signed files are reported.
 */
export async function analyzePdf(bytes: ArrayBuffer | Uint8Array): Promise<PdfAnalysis> {
  const srcBytes = bytes.byteLength;

  let doc: PDFDocument;
  try {
    // `ignoreEncryption` so we can inspect (and then refuse) rather than throw;
    // `updateMetadata: false` so a mere read does not rewrite the Info dict.
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return refusalResult(0, srcBytes, 'unreadable');
  }

  const refusal = documentRefusal(doc);
  if (refusal) return refusalResult(doc.getPageCount(), srcBytes, refusal);

  const byRef = enumerateImages(doc);
  attributePlacements(doc, byRef);

  const images: PdfImageInfo[] = [];
  let imageBytes = 0;
  for (const acc of byRef.values()) {
    imageBytes += acc.srcBytes;
    images.push(finish(acc));
  }

  return { pageCount: doc.getPageCount(), srcBytes, images, imageBytes };
}

function refusalResult(
  pageCount: number,
  srcBytes: number,
  refusal: PdfRefusal,
): PdfAnalysis {
  return { pageCount, srcBytes, images: [], imageBytes: 0, refusal };
}

/* -------------------------------------------------------------------------- */
/* Refusals                                                                    */
/* -------------------------------------------------------------------------- */

function documentRefusal(doc: PDFDocument): PdfRefusal | undefined {
  if (doc.isEncrypted) return 'encrypted';
  if (isSigned(doc)) return 'signed';
  return undefined;
}

/**
 * A document is signed if its AcroForm advertises signatures, or any object is
 * (or holds) a signature. Any rewrite breaks the signature, so we never touch
 * these — refusing is the honest move.
 */
function isSigned(doc: PDFDocument): boolean {
  const acro = doc.catalog.AcroForm();
  if (acro instanceof PDFDict) {
    const flags = acro.lookup(KEY.SigFlags);
    // Bit 1 SignaturesExist, bit 2 AppendOnly — either means a signature is in play.
    if (flags instanceof PDFNumber && (flags.asNumber() & 0b11) !== 0) return true;
  }
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = dictOf(obj);
    if (!dict) continue;
    const ft = dict.lookup(KEY.FT);
    const type = dict.lookup(KEY.Type);
    if (
      (ft instanceof PDFName && ft.asString() === '/Sig') ||
      (type instanceof PDFName && type.asString() === '/Sig') ||
      dict.has(KEY.ByteRange)
    ) {
      return true;
    }
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Image enumeration                                                           */
/* -------------------------------------------------------------------------- */

/** Mutable working record, folded into a {@link PdfImageInfo} at the end. */
interface ImageAcc {
  readonly ref: string;
  readonly width: number;
  readonly height: number;
  readonly filter: PdfImageFilter;
  readonly colorSpace: string;
  readonly bitsPerComponent: number;
  readonly hasSMask: boolean;
  readonly isMask: boolean;
  readonly srcBytes: number;
  readonly pages: Set<number>;
  /** Largest effective DPI seen across every draw; `undefined` until placed. */
  dpi: number | undefined;
}

function enumerateImages(doc: PDFDocument): Map<string, ImageAcc> {
  const byRef = new Map<string, ImageAcc>();
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!isImageStream(obj)) continue;
    const dict = obj.dict;
    const isMask = boolAt(dict, KEY.ImageMask);
    byRef.set(ref.tag, {
      ref: ref.tag,
      width: numAt(dict, KEY.Width) ?? 0,
      height: numAt(dict, KEY.Height) ?? 0,
      filter: filterOf(dict),
      colorSpace: colorSpaceOf(dict),
      // A stencil mask has no /BitsPerComponent; it is one bit by definition.
      bitsPerComponent: numAt(dict, KEY.BitsPerComponent) ?? (isMask ? 1 : 8),
      hasSMask: dict.has(KEY.SMask),
      isMask,
      srcBytes: obj.getContentsSize(),
      pages: new Set<number>(),
      dpi: undefined,
    });
  }
  return byRef;
}

function finish(acc: ImageAcc): PdfImageInfo {
  return {
    ref: acc.ref,
    pageIndices: [...acc.pages].sort((a, b) => a - b),
    width: acc.width,
    height: acc.height,
    filter: acc.filter,
    colorSpace: acc.colorSpace,
    bitsPerComponent: acc.bitsPerComponent,
    hasSMask: acc.hasSMask,
    isMask: acc.isMask,
    srcBytes: acc.srcBytes,
    ...(acc.dpi !== undefined ? { effectiveDpi: acc.dpi } : {}),
  };
}

function isImageStream(obj: PDFObject): obj is PDFRawStream {
  if (!(obj instanceof PDFRawStream)) return false;
  const sub = obj.dict.lookup(KEY.Subtype);
  // Images often omit /Type, so key on /Subtype /Image alone.
  return sub instanceof PDFName && sub.asString() === '/Image';
}

/** The last filter in the chain — the one that dictates how bytes decode. */
function filterOf(dict: PDFDict): PdfImageFilter {
  const filter = dict.lookup(KEY.Filter);
  if (filter instanceof PDFName) return toFilter(filter.decodeText());
  if (filter instanceof PDFArray && filter.size() > 0) {
    const last = filter.lookup(filter.size() - 1);
    if (last instanceof PDFName) return toFilter(last.decodeText());
  }
  return 'unknown';
}

function toFilter(name: string): PdfImageFilter {
  return KNOWN_FILTERS.has(name) ? (name as PdfImageFilter) : 'unknown';
}

/** Raw family name with the leading slash, e.g. `"/DeviceRGB"`, `"/ICCBased"`. */
function colorSpaceOf(dict: PDFDict): string {
  const cs = dict.lookup(KEY.ColorSpace);
  if (cs instanceof PDFName) return cs.asString();
  if (cs instanceof PDFArray && cs.size() > 0) {
    const family = cs.lookup(0);
    if (family instanceof PDFName) return family.asString();
  }
  return '';
}

/* -------------------------------------------------------------------------- */
/* Placement attribution                                                       */
/* -------------------------------------------------------------------------- */

function attributePlacements(doc: PDFDocument, byRef: Map<string, ImageAcc>): void {
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i += 1) {
    const leaf = pages[i]?.node;
    if (!leaf) continue;
    const placements = walkContentStream(pageContentBytes(leaf), makeResolver(resourcesOf(leaf)));
    for (const placement of placements) {
      if (!placement.ref) continue;
      const acc = byRef.get(placement.ref);
      if (!acc) continue;
      acc.pages.add(i);
      const dpi = effectiveDpi(placement.ctm, acc.width, acc.height);
      if (dpi > 0) acc.dpi = acc.dpi === undefined ? dpi : Math.max(acc.dpi, dpi);
    }
  }
}

/**
 * Resolve a content-stream `/Name` to what it draws, so the walker can recurse
 * into forms and attribute images without knowing anything about pdf-lib.
 */
function makeResolver(resources: PDFDict | undefined): XObjectResolver {
  return (name) => {
    const xobjects = resources?.lookup(KEY.XObject);
    if (!(xobjects instanceof PDFDict)) return undefined;
    const key = PDFName.of(name);
    const obj = xobjects.lookup(key);
    if (!(obj instanceof PDFRawStream)) return undefined;
    const subtype = obj.dict.lookup(KEY.Subtype);
    const kind = subtype instanceof PDFName ? subtype.asString() : '';

    if (kind === '/Image') {
      // `get` keeps the ref (it does not resolve it), so we can name the object.
      const asRef = xobjects.get(key);
      return { kind: 'image', ref: asRef instanceof PDFRef ? asRef.tag : undefined };
    }
    if (kind === '/Form') {
      const own = obj.dict.lookup(PDFName.of('Resources'));
      const inner = own instanceof PDFDict ? own : resources; // spec: forms inherit scope
      return {
        kind: 'form',
        contents: decodedBytes(obj),
        matrix: matrixOf(obj.dict),
        resolve: makeResolver(inner),
      };
    }
    return undefined;
  };
}

function matrixOf(dict: PDFDict): Matrix | undefined {
  const m = dict.lookup(PDFName.of('Matrix'));
  if (!(m instanceof PDFArray) || m.size() !== 6) return undefined;
  const values: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const n = m.lookup(i);
    if (!(n instanceof PDFNumber)) return undefined;
    values.push(n.asNumber());
  }
  return values as unknown as Matrix;
}

/** Own `/Resources`, or the inherited one from an ancestor page node. */
function resourcesOf(leaf: PDFPageLeaf): PDFDict | undefined {
  const own = leaf.Resources();
  if (own) return own;
  const inherited = leaf.getInheritableAttribute(PDFName.of('Resources'));
  return inherited instanceof PDFDict ? inherited : undefined;
}

/** Decoded, concatenated content bytes for a page (Contents may be an array). */
function pageContentBytes(leaf: PDFPageLeaf): Uint8Array {
  const contents = leaf.Contents();
  if (!contents) return new Uint8Array(0);

  const parts: Uint8Array[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) {
      const stream = contents.lookup(i);
      if (stream instanceof PDFRawStream) {
        parts.push(decodedBytes(stream));
        parts.push(SEPARATOR); // spec: streams join with whitespace, not edge-to-edge
      }
    }
  } else if (contents instanceof PDFRawStream) {
    parts.push(decodedBytes(contents));
  }
  return concat(parts);
}

const SEPARATOR = new Uint8Array([0x0a]);

/** Flate/LZW/ASCII decode. Never throws — an undecodable stream is skipped. */
function decodedBytes(stream: PDFRawStream): Uint8Array {
  try {
    return decodePDFRawStream(stream).decode();
  } catch {
    return new Uint8Array(0);
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function dictOf(obj: PDFObject): PDFDict | undefined {
  if (obj instanceof PDFRawStream) return obj.dict;
  if (obj instanceof PDFDict) return obj;
  return undefined;
}

function numAt(dict: PDFDict, key: PDFName): number | undefined {
  const value = dict.lookup(key);
  return value instanceof PDFNumber ? value.asNumber() : undefined;
}

function boolAt(dict: PDFDict, key: PDFName): boolean {
  const value = dict.lookup(key);
  return value instanceof PDFBool && value.asBoolean();
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
