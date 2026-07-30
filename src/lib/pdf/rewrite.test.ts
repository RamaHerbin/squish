import { deflateSync } from 'node:zlib';

import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';

import { dedupeImages, replaceImageStream, stripMetadata } from './rewrite';

/* -------------------------------------------------------------------------- */
/* Fixtures — real PDFs built with pdf-lib, real PNGs built with zlib          */
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

function assemblePng(ihdr: Uint8Array, raw: Uint8Array): Uint8Array {
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

/** 8-bit RGB PNG — pdf-lib embeds it as a FlateDecode DeviceRGB image. */
function makePng(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const off = y * (1 + width * 3);
    raw[off] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const p = off + 1 + x * 3;
      raw[p] = (x * 2) & 255;
      raw[p + 1] = (y * 2) & 255;
      raw[p + 2] = 128;
    }
  }
  return assemblePng(ihdr, raw);
}

/** 8-bit RGBA PNG — pdf-lib embeds the colour plane plus a DeviceGray /SMask. */
function makePngAlpha(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = truecolour with alpha
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const off = y * (1 + width * 4);
    raw[off] = 0;
    for (let x = 0; x < width; x += 1) {
      const p = off + 1 + x * 4;
      raw[p] = (x * 2) & 255;
      raw[p + 1] = (y * 2) & 255;
      raw[p + 2] = 128;
      raw[p + 3] = (x * 3 + y * 5) & 255;
    }
  }
  return assemblePng(ihdr, raw);
}

/* -------------------------------------------------------------------------- */

function imageStreams(doc: PDFDocument): Array<{ ref: PDFRef; stream: PDFRawStream }> {
  const out: Array<{ ref: PDFRef; stream: PDFRawStream }> = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') {
      out.push({ ref, stream: obj });
    }
  }
  return out;
}

/** Build a one-page doc with `png` drawn, save and reload it. */
async function docWithImage(png: Uint8Array): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(png);
  const page = doc.addPage([200, 200]);
  page.drawImage(image, { x: 10, y: 10, width: 120, height: 120 });
  return PDFDocument.load(await doc.save());
}

/* -------------------------------------------------------------------------- */

describe('replaceImageStream', () => {
  it('swaps in a baseline-JPEG dict and drops the stale keys', async () => {
    const doc = await docWithImage(makePng(20, 20));
    const [image] = imageStreams(doc);
    expect(image).toBeDefined();
    const ref = image!.ref;

    const injected = Uint8Array.of(1, 2, 3, 4, 5);
    replaceImageStream(doc, ref, injected, { width: 20, height: 20, colorSpace: 'DeviceRGB' });

    const reloaded = await PDFDocument.load(await doc.save());
    const streams = imageStreams(reloaded);
    expect(streams).toHaveLength(1);
    const { stream } = streams[0]!;
    const dict = stream.dict;

    expect(dict.get(PDFName.of('Filter'))?.toString()).toBe('/DCTDecode');
    expect(dict.get(PDFName.of('ColorSpace'))?.toString()).toBe('/DeviceRGB');
    expect((dict.get(PDFName.of('Width')) as PDFNumber).asNumber()).toBe(20);
    expect((dict.get(PDFName.of('Height')) as PDFNumber).asNumber()).toBe(20);
    expect((dict.get(PDFName.of('BitsPerComponent')) as PDFNumber).asNumber()).toBe(8);

    // The keys a DCTDecode stream must not carry are gone.
    expect(dict.has(PDFName.of('DecodeParms'))).toBe(false);
    expect(dict.has(PDFName.of('SMask'))).toBe(false);
    expect(dict.has(PDFName.of('Decode'))).toBe(false);

    // Contents are exactly the injected bytes, and /Length was recomputed to match.
    expect(Array.from(stream.getContents())).toEqual([1, 2, 3, 4, 5]);
    expect((dict.get(PDFName.of('Length')) as PDFNumber).asNumber()).toBe(stream.getContents().length);
  });

  it('deletes the orphaned soft mask when it replaces an image that had one', async () => {
    const doc = await docWithImage(makePngAlpha(20, 20));
    // The colour image is the stream that carries an /SMask ref.
    const image = imageStreams(doc).find(({ stream }) => stream.dict.get(PDFName.of('SMask')) instanceof PDFRef);
    expect(image).toBeDefined();
    const smaskRef = image!.stream.dict.get(PDFName.of('SMask')) as PDFRef;
    expect(doc.context.lookup(smaskRef)).toBeInstanceOf(PDFRawStream);

    replaceImageStream(doc, image!.ref, Uint8Array.of(9, 9, 9), {
      width: 20,
      height: 20,
      colorSpace: 'DeviceRGB',
    });

    // The old mask object is gone, and the replacement carries no /SMask.
    expect(doc.context.lookup(smaskRef)).toBeUndefined();
    const replaced = doc.context.lookup(image!.ref) as PDFRawStream;
    expect(replaced.dict.has(PDFName.of('SMask'))).toBe(false);
  });
});

describe('dedupeImages', () => {
  it('collapses byte-identical images and repoints both pages', async () => {
    const png = makePng(20, 20);
    const doc = await PDFDocument.create();
    const a = await doc.embedPng(png);
    const b = await doc.embedPng(png);
    doc.addPage([200, 200]).drawImage(a, { x: 0, y: 0, width: 100, height: 100 });
    doc.addPage([200, 200]).drawImage(b, { x: 0, y: 0, width: 100, height: 100 });
    const loaded = await PDFDocument.load(await doc.save());

    expect(imageStreams(loaded)).toHaveLength(2);
    expect(dedupeImages(loaded)).toBe(1);
    expect(imageStreams(loaded)).toHaveLength(1);

    // Both pages resolve their one XObject entry to the single surviving stream.
    const survivor = imageStreams(loaded)[0]!.ref;
    for (const page of loaded.getPages()) {
      const resources = page.node.lookup(PDFName.of('Resources'));
      expect(resources).toBeInstanceOf(PDFDict);
      const xobjects = (resources as PDFDict).lookup(PDFName.of('XObject'));
      expect(xobjects).toBeInstanceOf(PDFDict);
      for (const [, value] of (xobjects as PDFDict).entries()) {
        expect(value).toBe(survivor);
      }
    }
  });

  it('leaves distinct images untouched', async () => {
    const doc = await PDFDocument.create();
    const a = await doc.embedPng(makePng(20, 20));
    const b = await doc.embedPng(makePng(24, 24));
    doc.addPage([200, 200]).drawImage(a, { x: 0, y: 0, width: 100, height: 100 });
    doc.addPage([200, 200]).drawImage(b, { x: 0, y: 0, width: 100, height: 100 });
    const loaded = await PDFDocument.load(await doc.save());

    expect(dedupeImages(loaded)).toBe(0);
    expect(imageStreams(loaded)).toHaveLength(2);
  });

  it('keeps byte-identical planes apart when they carry different soft masks', async () => {
    const png = makePng(20, 20);
    const doc = await PDFDocument.create();
    const a = await doc.embedPng(png);
    const b = await doc.embedPng(png);
    doc.addPage([200, 200]).drawImage(a, { x: 0, y: 0, width: 100, height: 100 });
    doc.addPage([200, 200]).drawImage(b, { x: 0, y: 0, width: 100, height: 100 });
    const loaded = await PDFDocument.load(await doc.save());

    // Two distinct masks over the same colour plane. Collapsing these would give
    // both draws the canonical object's transparency and repaint the document.
    const [first, second] = imageStreams(loaded);
    first!.stream.dict.set(
      PDFName.of('SMask'),
      loaded.context.register(loaded.context.stream('mask-one')),
    );
    second!.stream.dict.set(
      PDFName.of('SMask'),
      loaded.context.register(loaded.context.stream('mask-two')),
    );

    expect(dedupeImages(loaded)).toBe(0);
    expect(imageStreams(loaded)).toHaveLength(2);
  });

  it('keeps byte-identical planes apart when only one inverts /Decode', async () => {
    const png = makePng(20, 20);
    const doc = await PDFDocument.create();
    const a = await doc.embedPng(png);
    const b = await doc.embedPng(png);
    doc.addPage([200, 200]).drawImage(a, { x: 0, y: 0, width: 100, height: 100 });
    doc.addPage([200, 200]).drawImage(b, { x: 0, y: 0, width: 100, height: 100 });
    const loaded = await PDFDocument.load(await doc.save());

    const [, second] = imageStreams(loaded);
    second!.stream.dict.set(PDFName.of('Decode'), loaded.context.obj([1, 0, 1, 0, 1, 0]));

    expect(dedupeImages(loaded)).toBe(0);
    expect(imageStreams(loaded)).toHaveLength(2);
  });
});

describe('stripMetadata', () => {
  it('removes the catalog /Metadata and every page /Thumb, objects and all', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);

    const metaRef = doc.context.register(doc.context.stream('<xml/>'));
    doc.catalog.set(PDFName.of('Metadata'), metaRef);
    const thumbRef = doc.context.register(doc.context.stream('thumb-bytes'));
    page.node.set(PDFName.of('Thumb'), thumbRef);

    stripMetadata(doc);

    expect(doc.catalog.has(PDFName.of('Metadata'))).toBe(false);
    expect(page.node.has(PDFName.of('Thumb'))).toBe(false);
    expect(doc.context.lookup(metaRef)).toBeUndefined();
    expect(doc.context.lookup(thumbRef)).toBeUndefined();
  });
});
