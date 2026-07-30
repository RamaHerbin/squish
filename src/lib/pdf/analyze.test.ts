import { deflateSync } from 'node:zlib';

import { PDFDocument, PDFName, PDFNumber, PDFRawStream, type PDFDict } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';

import { analyzePdf } from './analyze';

/* -------------------------------------------------------------------------- */
/* Fixtures — real PDFs built with pdf-lib, real PNGs built with zlib          */
/* -------------------------------------------------------------------------- */

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
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

/** A valid 8-bit RGB PNG with a deterministic gradient — no alpha, so pdf-lib
 *  embeds it as a FlateDecode DeviceRGB image. */
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

/* -------------------------------------------------------------------------- */

describe('analyzePdf — refusals', () => {
  it('refuses a file pdf-lib cannot parse without throwing', async () => {
    const garbage = new TextEncoder().encode('this is not a pdf');
    const analysis = await analyzePdf(garbage);
    expect(analysis.refusal).toBe('unreadable');
    expect(analysis.images).toEqual([]);
    expect(analysis.pageCount).toBe(0);
    expect(analysis.srcBytes).toBe(garbage.byteLength);
  });

  it('refuses a signed document (AcroForm /SigFlags)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const acro = doc.context.obj({});
    acro.set(PDFName.of('SigFlags'), PDFNumber.of(3)); // SignaturesExist | AppendOnly
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(acro));
    const bytes = await doc.save();

    const analysis = await analyzePdf(bytes);
    expect(analysis.refusal).toBe('signed');
    expect(analysis.images).toEqual([]);
    expect(analysis.pageCount).toBe(1);
  });
});

describe('analyzePdf — structure', () => {
  it('reports pages and no images for an image-free document', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.addPage();
    const analysis = await analyzePdf(await doc.save());
    expect(analysis.refusal).toBeUndefined();
    expect(analysis.pageCount).toBe(2);
    expect(analysis.images).toEqual([]);
    expect(analysis.imageBytes).toBe(0);
  });

  it('finds a drawn image with its filter, colour space, size and effective DPI', async () => {
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(makePng(120, 90));
    const page = doc.addPage([200, 200]);
    // Draw the 120x90 image into a 150x120 pt box.
    page.drawImage(png, { x: 10, y: 10, width: 150, height: 120 });
    const bytes = await doc.save();

    const analysis = await analyzePdf(bytes);
    expect(analysis.refusal).toBeUndefined();
    expect(analysis.pageCount).toBe(1);
    expect(analysis.images).toHaveLength(1);

    const [image] = analysis.images;
    expect(image?.filter).toBe('FlateDecode'); // RGB PNG -> Flate DeviceRGB
    expect(image?.colorSpace).toBe('/DeviceRGB');
    expect(image?.width).toBe(120);
    expect(image?.height).toBe(90);
    expect(image?.isMask).toBe(false);
    expect(image?.hasSMask).toBe(false);
    expect(image?.pageIndices).toEqual([0]);
    expect(image?.srcBytes).toBeGreaterThan(0);
    expect(analysis.imageBytes).toBe(image?.srcBytes);
    // Across: 120*72/150 = 57.6; down: 90*72/120 = 54. The higher axis wins.
    expect(image?.effectiveDpi).toBeCloseTo(57.6, 1);
  });

  it('attributes every page a shared image is drawn on and keeps the largest DPI', async () => {
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(makePng(120, 90));
    // Page 0: a big box (low DPI). Page 1: a small box (high DPI).
    const big = doc.addPage([400, 400]);
    big.drawImage(png, { x: 0, y: 0, width: 360, height: 270 });
    const small = doc.addPage([400, 400]);
    small.drawImage(png, { x: 0, y: 0, width: 60, height: 45 });
    const bytes = await doc.save();

    const analysis = await analyzePdf(bytes);
    expect(analysis.images).toHaveLength(1);
    const [image] = analysis.images;
    expect(image?.pageIndices).toEqual([0, 1]);
    // Smallest box is 60pt wide for 120px -> 144 DPI, which must win.
    expect(image?.effectiveDpi).toBeCloseTo(144, 0);
  });

  it('divides the effective DPI by the page /UserUnit', async () => {
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(makePng(120, 90));
    const page = doc.addPage([200, 200]);
    page.drawImage(png, { x: 10, y: 10, width: 150, height: 120 });
    // One user-space unit is worth two points: the page draws twice as large as
    // its coordinates suggest, so the real resolution is half what they imply.
    page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    const bytes = await doc.save();

    const analysis = await analyzePdf(bytes);
    const [image] = analysis.images;
    // Same placement as the un-scaled case (57.6), halved.
    expect(image?.effectiveDpi).toBeCloseTo(28.8, 1);
  });
});

/**
 * A one-page document with one embedded PNG, with `patch` applied to that
 * image's dict — the way to fabricate stream shapes pdf-lib will not write on
 * its own.
 *
 * The save/reload in the middle is load-bearing: `embedPng` only reserves a ref,
 * and the stream object it names does not exist until the document is written.
 */
async function pdfWithImageDict(
  patch: (dict: PDFDict, doc: PDFDocument) => void,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(makePng(120, 90));
  const page = doc.addPage([200, 200]);
  page.drawImage(png, { x: 10, y: 10, width: 150, height: 120 });

  const loaded = await PDFDocument.load(await doc.save());
  let patched = 0;
  for (const [, obj] of loaded.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === IMAGE) {
      patch(obj.dict, loaded);
      patched += 1;
    }
  }
  expect(patched).toBe(1); // a vacuous fixture would make every assertion pass
  return loaded.save();
}

const IMAGE = PDFName.of('Image');

describe('analyzePdf — undecodable shapes', () => {
  it('reports a multi-filter chain as unknown rather than its last filter', async () => {
    // Pretend the stream arrived ASCII85-wrapped. The DCT path hands the stored
    // bytes straight to the JPEG decoder, so this must not be judged eligible.
    const bytes = await pdfWithImageDict((dict, doc) => {
      dict.set(PDFName.of('Filter'), doc.context.obj(['ASCII85Decode', 'DCTDecode']));
    });

    const analysis = await analyzePdf(bytes);
    expect(analysis.images[0]?.filter).toBe('unknown');
  });

  it('still reads a single-entry filter array', async () => {
    const bytes = await pdfWithImageDict((dict, doc) => {
      dict.set(PDFName.of('Filter'), doc.context.obj(['FlateDecode']));
    });

    const analysis = await analyzePdf(bytes);
    expect(analysis.images[0]?.filter).toBe('FlateDecode');
  });

  it('flags a non-identity /Decode and leaves an identity one alone', async () => {
    const decodeFlag = async (decode?: readonly number[]): Promise<boolean | undefined> => {
      const bytes = await pdfWithImageDict((dict, doc) => {
        if (decode) dict.set(PDFName.of('Decode'), doc.context.obj([...decode]));
      });
      const analysis = await analyzePdf(bytes);
      return analysis.images[0]?.hasCustomDecode;
    };

    expect(await decodeFlag()).toBe(false);
    expect(await decodeFlag([0, 1, 0, 1, 0, 1])).toBe(false); // the identity, written out
    expect(await decodeFlag([1, 0, 1, 0, 1, 0])).toBe(true); // inverted
  });
});
