import { deflateSync } from 'node:zlib';

import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PDF_SETTINGS } from '../contracts';
import type { PdfImageInfo, WorkerBridgeApi } from '../contracts';

import { compressPdf, type PdfCompressDeps } from './compress';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map((ch) => ch.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(body, 4);
  dv.setUint32(4 + body.length, crc32(body));
  return out;
}

/** A high-entropy 8-bit RGB PNG, big enough that its Flate stream clears the
 *  4 KB floor (a smooth gradient would compress under it). */
function makeNoisyPng(size: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = new Uint8Array(size * (1 + size * 3));
  for (let y = 0; y < size; y += 1) {
    const off = y * (1 + size * 3);
    raw[off] = 0;
    for (let x = 0; x < size; x += 1) {
      const p = off + 1 + x * 3;
      const v = (Math.imul(x, 2654435761) + Math.imul(y, 40503)) >>> 0;
      raw[p] = v & 255;
      raw[p + 1] = (v >>> 8) & 255;
      raw[p + 2] = (v >>> 16) & 255;
    }
  }
  const idat = new Uint8Array(deflateSync(raw));
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const PNG = makeNoisyPng(256);

/** One page, the image drawn into a `box`×`box` pt frame (default 256 → 72 DPI,
 *  so it is not resampled). A small box raises the effective DPI. */
async function onePage(box = 256): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(PNG);
  const page = doc.addPage([320, 320]);
  page.drawImage(image, { x: 10, y: 10, width: box, height: box });
  return doc.save();
}

/** Two pages, each drawing its own embed of the same PNG (two distinct objects). */
async function twoPagesSameImage(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const a = await doc.embedPng(PNG);
  const b = await doc.embedPng(PNG);
  doc.addPage([320, 320]).drawImage(a, { x: 10, y: 10, width: 256, height: 256 });
  doc.addPage([320, 320]).drawImage(b, { x: 10, y: 10, width: 256, height: 256 });
  return doc.save();
}

function imageStreams(doc: PDFDocument): PDFRawStream[] {
  const out: PDFRawStream[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') {
      out.push(obj);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Fakes — never a real canvas or worker                                       */
/* -------------------------------------------------------------------------- */

function fakeImageData(w: number, h: number): ImageData {
  return {
    width: w,
    height: h,
    colorSpace: 'srgb',
    data: new Uint8ClampedArray(w * h * 4).fill(128),
  } as unknown as ImageData;
}

interface BridgeSpy {
  onEncode?: () => void;
  onDecode?: () => void;
  onTerminate?: () => void;
}

function fakeBridge(encoded: () => ArrayBuffer, spy: BridgeSpy = {}): WorkerBridgeApi {
  return {
    decode: async () => {
      spy.onDecode?.();
      return fakeImageData(8, 8);
    },
    encode: async () => {
      spy.onEncode?.();
      return encoded();
    },
    resize: async (_s: AbortSignal, d: ImageData) => d,
    rotate: async (_s: AbortSignal, d: ImageData) => d,
    preload: () => {},
    terminate: () => {
      spy.onTerminate?.();
    },
  } as unknown as WorkerBridgeApi;
}

/** Deps whose encode always returns `encodedBytes` bytes, decode/resample fake. */
function fakeDeps(encodedBytes: number, spy: BridgeSpy = {}): PdfCompressDeps {
  return {
    bridge: fakeBridge(() => new ArrayBuffer(encodedBytes), spy),
    decodeImageData: async (_deps, _stream, info) => fakeImageData(info.width, info.height),
    resampleImageData: (_data, size) => fakeImageData(size.width, size.height),
  };
}

/* -------------------------------------------------------------------------- */

describe('compressPdf', () => {
  it('replaces an image whose re-encode comes out smaller', async () => {
    const src = await onePage();
    const result = await compressPdf(src, DEFAULT_PDF_SETTINGS, fakeDeps(64));

    expect(result.replaced).toBe(1);
    expect(result.images).toHaveLength(1);
    const [outcome] = result.images;
    expect(outcome?.outBytes).toBe(64);
    expect(outcome?.skipped).toBeUndefined();
    expect(outcome?.ssim).toBeUndefined(); // measure is off by default

    const out = await PDFDocument.load(result.bytes);
    const [image] = imageStreams(out);
    expect(image?.dict.get(PDFName.of('Filter'))?.toString()).toBe('/DCTDecode');
    expect(image?.getContents().length).toBe(64);
    expect(result.outBytes).toBe(result.bytes.byteLength);
  });

  it('keeps the original when the re-encode is not smaller', async () => {
    const src = await onePage();
    const result = await compressPdf(src, DEFAULT_PDF_SETTINGS, fakeDeps(10_000_000));

    expect(result.replaced).toBe(0);
    expect(result.images[0]?.skipped).toBe('not-smaller');

    const out = await PDFDocument.load(result.bytes);
    expect(imageStreams(out)[0]?.dict.get(PDFName.of('Filter'))?.toString()).toBe('/FlateDecode');
  });

  it('skips a Flate image with the JPEG re-encode disabled, never decoding it', async () => {
    const src = await onePage();
    let decodeCalls = 0;
    const deps: PdfCompressDeps = {
      ...fakeDeps(64),
      decodeImageData: async (_deps, _stream, info) => {
        decodeCalls += 1;
        return fakeImageData(info.width, info.height);
      },
    };

    const result = await compressPdf(src, { ...DEFAULT_PDF_SETTINGS, flateToJpeg: false }, deps);

    expect(result.replaced).toBe(0);
    expect(result.images[0]?.skipped).toBe('no-decoder');
    expect(decodeCalls).toBe(0);
  });

  it('returns a refused document unchanged and never reaches the bridge', async () => {
    const garbage = new TextEncoder().encode('not a pdf');
    let encodeCalls = 0;
    const result = await compressPdf(garbage, DEFAULT_PDF_SETTINGS, fakeDeps(64, {
      onEncode: () => {
        encodeCalls += 1;
      },
    }));

    expect(result.images).toEqual([]);
    expect(result.replaced).toBe(0);
    expect(result.deduped).toBe(0);
    expect(result.bytes.byteLength).toBe(garbage.byteLength);
    expect(encodeCalls).toBe(0);
  });

  it('resamples an over-resolution image and replaces at the smaller size', async () => {
    // 256px drawn into a 20pt box → 256*72/20 = 921.6 DPI. Default target 150 →
    // scale 150/921.6 → round(256*150/921.6) = round(41.67) = 42.
    const src = await onePage(20);
    const result = await compressPdf(src, DEFAULT_PDF_SETTINGS, fakeDeps(64));

    expect(result.replaced).toBe(1);
    expect(result.images[0]?.resampledTo).toEqual({ width: 42, height: 42 });

    const out = await PDFDocument.load(result.bytes);
    const [image] = imageStreams(out);
    expect((image?.dict.get(PDFName.of('Width')) as PDFNumber).asNumber()).toBe(42);
    expect((image?.dict.get(PDFName.of('Height')) as PDFNumber).asNumber()).toBe(42);
  });

  it('collapses two identical replaced images when dedupe is on', async () => {
    const src = await twoPagesSameImage();
    const result = await compressPdf(src, DEFAULT_PDF_SETTINGS, fakeDeps(64));

    expect(result.replaced).toBe(2);
    expect(result.deduped).toBe(1);
  });

  it('leaves duplicates in place when dedupe is off', async () => {
    const src = await twoPagesSameImage();
    const result = await compressPdf(src, { ...DEFAULT_PDF_SETTINGS, dedupeImages: false }, fakeDeps(64));

    expect(result.replaced).toBe(2);
    expect(result.deduped).toBe(0);
  });

  it('does not terminate an injected bridge', async () => {
    const src = await onePage();
    let terminated = 0;
    await compressPdf(src, DEFAULT_PDF_SETTINGS, fakeDeps(64, {
      onTerminate: () => {
        terminated += 1;
      },
    }));
    expect(terminated).toBe(0);
  });

  it('reports progress once per image', async () => {
    const src = await onePage();
    const calls: Array<[number, number]> = [];
    await compressPdf(src, DEFAULT_PDF_SETTINGS, {
      ...fakeDeps(64),
      onProgress: (done, total) => calls.push([done, total]),
    });
    expect(calls).toEqual([[1, 1]]);
  });
});
