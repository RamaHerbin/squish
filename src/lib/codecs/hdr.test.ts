import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { HDR_SCAN_BYTES, detectHdr, hdrLabel } from './hdr';

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

/** Minimal `colr`/nclx box: header + `nclx` + primaries + transfer + matrix + range. */
function colrBox(transfer: number): number[] {
  return [
    0x00,
    0x00,
    0x00,
    0x13,
    ...ascii('colr'),
    ...ascii('nclx'),
    0x00,
    0x09, // primaries: BT.2020
    (transfer >> 8) & 0xff,
    transfer & 0xff,
    0x00,
    0x09, // matrix
    0x80, // full range
  ];
}

function heicHeader(...rest: number[]): Uint8Array {
  return new Uint8Array([0x00, 0x00, 0x00, 0x18, ...ascii('ftypheic'), ...rest]);
}

describe('detectHdr', () => {
  it('detects PQ and HLG from a colr/nclx box in BMFF files', () => {
    expect(detectHdr(heicHeader(...colrBox(16)), 'image/heic')).toEqual({ kind: 'pq' });
    expect(detectHdr(heicHeader(...colrBox(18)), 'image/avif')).toEqual({ kind: 'hlg' });
  });

  it('treats SDR transfers as not HDR', () => {
    // 13 = sRGB, 1 = BT.709
    expect(detectHdr(heicHeader(...colrBox(13)), 'image/heic')).toBeUndefined();
    expect(detectHdr(heicHeader(...colrBox(1)), 'image/heic')).toBeUndefined();
  });

  it('ignores colr boxes of non-nclx type', () => {
    const riccBox = [0x00, 0x00, 0x00, 0x0c, ...ascii('colr'), ...ascii('rICC')];
    expect(detectHdr(heicHeader(...riccBox), 'image/heic')).toBeUndefined();
  });

  it('does not read colr boxes outside BMFF mime types', () => {
    expect(detectHdr(heicHeader(...colrBox(16)), 'image/png')).toBeUndefined();
  });

  it('detects gain-map HDR by metadata marker in any container', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, ...ascii('...hdrgm:Version="1.0"...')]);
    expect(detectHdr(jpeg, 'image/jpeg')).toEqual({ kind: 'gainmap' });

    const apple = heicHeader(...ascii('urn:com:apple:photo:2020:aux:hdrgainmap'));
    expect(detectHdr(apple, 'image/heic')).toEqual({ kind: 'gainmap' });
  });

  it('returns undefined on plain SDR files and tiny buffers', () => {
    expect(detectHdr(new Uint8Array([0x89, 0x50]), 'image/png')).toBeUndefined();
    expect(detectHdr(new Uint8Array(0), 'image/heic')).toBeUndefined();
  });

  /**
   * The one case here that reads a real file. `public/demo/demo-hdr.avif` is a
   * bundled sample whose entire reason to exist is to light this detector up on
   * the home screen, and it is produced by a tool outside the npm tree
   * (`node scripts/generate-assets.mjs hdr`, which shells out to avifenc). A
   * synthetic fixture cannot notice that asset losing its PQ tag; this can.
   */
  it('detects the bundled HDR sample as PQ', () => {
    const file = fileURLToPath(new URL('../../../public/demo/demo-hdr.avif', import.meta.url));
    const head = readFileSync(file).subarray(0, HDR_SCAN_BYTES);
    expect(detectHdr(new Uint8Array(head), 'image/avif')).toEqual({ kind: 'pq' });
  });
});

describe('hdrLabel', () => {
  it('labels each kind', () => {
    expect(hdrLabel({ kind: 'pq' })).toBe('HDR (PQ)');
    expect(hdrLabel({ kind: 'hlg' })).toBe('HDR (HLG)');
    expect(hdrLabel({ kind: 'gainmap' })).toBe('HDR (gain map)');
  });
});
