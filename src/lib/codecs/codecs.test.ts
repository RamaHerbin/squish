import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ENCODER_OPTIONS,
  ENCODER_IDS,
  EXTENSION_BY_MIME,
  defaultOptionsFor,
  isWorkerEncoderId,
  type EncoderId,
  type TransferableImageData,
  type WorkerBridgeApi,
} from '../contracts';
import { isImageMimeType, resolveMimeType } from './decode';
import {
  ENCODER_METAS,
  ENCODER_REGISTRY,
  createEncoderLoader,
  encoderExtension,
  getEncoderMeta,
  outputFileName,
} from './registry';
import { rotateTransferable, rotationSwapsAxes } from './rotate';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** An image whose pixels are the numbers 1..w*h, one per RGBA quad. */
function makeImage(width: number, height: number): TransferableImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  const view = new Uint32Array(data.buffer);
  for (let i = 0; i < view.length; i++) view[i] = i + 1;
  return { data, width, height };
}

function pixels(image: TransferableImageData): number[] {
  const { data } = image;
  return Array.from(new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4));
}

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

describe('encoder registry', () => {
  it('covers every encoder id, keyed by its own id', () => {
    for (const id of ENCODER_IDS) {
      expect(ENCODER_REGISTRY[id].id).toBe(id);
    }
    expect(Object.keys(ENCODER_REGISTRY).sort()).toEqual([...ENCODER_IDS].sort());
  });

  it('lists metas in the contract display order', () => {
    expect(ENCODER_METAS.map((meta) => meta.id)).toEqual([...ENCODER_IDS]);
  });

  it('reuses the shared default options rather than copying them', () => {
    for (const id of ENCODER_IDS) {
      expect(ENCODER_REGISTRY[id].defaultOptions).toBe(DEFAULT_ENCODER_OPTIONS[id]);
    }
  });

  it('does not let a caller poison the defaults through the registry', () => {
    const fresh = defaultOptionsFor('mozjpeg');
    fresh.quality = 1;
    expect(getEncoderMeta('mozjpeg').defaultOptions.quality).toBe(
      DEFAULT_ENCODER_OPTIONS.mozjpeg.quality,
    );
  });

  it('agrees with the contract extension table', () => {
    for (const id of ENCODER_IDS) {
      const meta = ENCODER_REGISTRY[id];
      if (!meta.mimeType) {
        expect(meta.extension).toBe('');
        continue;
      }
      expect(meta.extension).toBe(EXTENSION_BY_MIME[meta.mimeType]);
    }
  });

  it('routes exactly the wasm codecs through the worker', () => {
    for (const id of ENCODER_IDS) {
      expect(ENCODER_REGISTRY[id].usesWorker).toBe(isWorkerEncoderId(id));
    }
  });

  it('marks identity as the only encoder without an output type', () => {
    const typeless = ENCODER_IDS.filter((id) => ENCODER_REGISTRY[id].mimeType === '');
    expect(typeless).toEqual(['identity']);
  });
});

describe('outputFileName', () => {
  it('swaps the extension for the encoder that produced the file', () => {
    expect(outputFileName('photo.png', 'mozjpeg')).toBe('photo.jpg');
    expect(outputFileName('photo.jpeg', 'avif')).toBe('photo.avif');
    expect(outputFileName('photo.png', 'browser-webp')).toBe('photo.webp');
  });

  it('appends an extension when the source has none', () => {
    expect(outputFileName('photo', 'oxipng')).toBe('photo.png');
  });

  it('leaves the name alone for identity, which is the source file', () => {
    expect(outputFileName('photo.tiff', 'identity')).toBe('photo.tiff');
    expect(encoderExtension('identity')).toBe('');
  });

  it('keeps dots in the stem', () => {
    expect(outputFileName('holiday.2024.final.png', 'webp')).toBe(
      'holiday.2024.final.webp',
    );
  });
});

describe('createEncoderLoader', () => {
  const calls: Array<{ id: EncoderId }> = [];

  const bridge: WorkerBridgeApi = {
    decode: () => Promise.reject(new Error('not used')),
    encode: (_signal, id) => {
      calls.push({ id });
      return Promise.resolve(new ArrayBuffer(4));
    },
    resize: () => Promise.reject(new Error('not used')),
    rotate: () => Promise.reject(new Error('not used')),
    preload: () => undefined,
    terminate: () => undefined,
  };

  it('memoises one module per encoder id', async () => {
    const load = createEncoderLoader(bridge);
    expect(load('mozjpeg')).toBe(load('mozjpeg'));
    expect(await load('mozjpeg')).toBe(await load('mozjpeg'));
  });

  it('wires a wasm encoder to the bridge', async () => {
    const load = createEncoderLoader(bridge);
    const module = await load('webp');

    expect(module.meta.id).toBe('webp');
    const result = await module.encode(
      new AbortController().signal,
      {} as ImageData,
      defaultOptionsFor('webp'),
    );

    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(calls.at(-1)?.id).toBe('webp');
  });

  it('loads canvas encoders without touching the bridge', async () => {
    const load = createEncoderLoader(bridge);
    const module = await load('browser-png');
    expect(module.meta.id).toBe('browser-png');
    expect(module.meta.usesWorker).toBe(false);
  });

  it('refuses to encode through identity', async () => {
    const load = createEncoderLoader(bridge);
    const module = await load('identity');
    await expect(
      module.encode(new AbortController().signal, {} as ImageData, {}),
    ).rejects.toThrow(/identity/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Rotation                                                                    */
/* -------------------------------------------------------------------------- */

describe('rotateTransferable', () => {
  //  1 2
  //  3 4
  //  5 6
  const source = () => makeImage(2, 3);

  it('passes 0° straight through, without copying', () => {
    const image = source();
    expect(rotateTransferable(image, 0)).toBe(image);
  });

  it('rotates 90° clockwise and swaps the axes', () => {
    const rotated = rotateTransferable(source(), 90);
    expect([rotated.width, rotated.height]).toEqual([3, 2]);
    expect(pixels(rotated)).toEqual([5, 3, 1, 6, 4, 2]);
  });

  it('rotates 180° in place', () => {
    const rotated = rotateTransferable(source(), 180);
    expect([rotated.width, rotated.height]).toEqual([2, 3]);
    expect(pixels(rotated)).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it('rotates 270° clockwise', () => {
    const rotated = rotateTransferable(source(), 270);
    expect([rotated.width, rotated.height]).toEqual([3, 2]);
    expect(pixels(rotated)).toEqual([2, 4, 6, 1, 3, 5]);
  });

  it('composes: two 90° turns equal one 180°', () => {
    const twice = rotateTransferable(rotateTransferable(source(), 90), 90);
    const once = rotateTransferable(source(), 180);
    expect(pixels(twice)).toEqual(pixels(once));
    expect([twice.width, twice.height]).toEqual([once.width, once.height]);
  });

  it('returns to the original after four turns', () => {
    let image = source();
    for (let i = 0; i < 4; i++) image = rotateTransferable(image, 90);
    expect(pixels(image)).toEqual(pixels(source()));
    expect([image.width, image.height]).toEqual([2, 3]);
  });

  it('leaves the input untouched', () => {
    const image = source();
    rotateTransferable(image, 90);
    expect(pixels(image)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rejects a buffer that does not match the dimensions', () => {
    const broken: TransferableImageData = {
      data: new Uint8ClampedArray(4),
      width: 3,
      height: 3,
    };
    expect(() => rotateTransferable(broken, 90)).toThrow(/does not match/);
  });
});

describe('rotationSwapsAxes', () => {
  it('is true exactly for quarter turns', () => {
    expect(rotationSwapsAxes(0, 90)).toBe(true);
    expect(rotationSwapsAxes(90, 0)).toBe(true);
    expect(rotationSwapsAxes(90, 180)).toBe(true);
    expect(rotationSwapsAxes(0, 180)).toBe(false);
    expect(rotationSwapsAxes(90, 270)).toBe(false);
    expect(rotationSwapsAxes(180, 180)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* MIME resolution                                                             */
/* -------------------------------------------------------------------------- */

describe('resolveMimeType', () => {
  it('trusts magic numbers over everything else', () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    expect(resolveMimeType(png, 'image/jpeg', 'lies.jpg')).toEqual({
      mimeType: 'image/png',
      source: 'magic-number',
    });
  });

  it('recognises a JPEG header', () => {
    expect(resolveMimeType(bytes(0xff, 0xd8, 0xff, 0xe0)).mimeType).toBe('image/jpeg');
  });

  it('recognises a WebP RIFF/VP8 header by magic number, not by declared type', () => {
    const webp = ascii('RIFF\0\0\0\0WEBPVP8 ');
    expect(resolveMimeType(webp, 'application/octet-stream', 'clip.bin')).toEqual({
      mimeType: 'image/webp',
      source: 'magic-number',
    });
  });

  it('recognises an AVIF ISOBMFF header by magic number', () => {
    const avif = bytes(
      0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0x00, 0x00, 0x00,
      0x00,
    );
    expect(resolveMimeType(avif).mimeType).toBe('image/avif');
  });

  it('recognises both JXL magic numbers — bare codestream and ISOBMFF container', () => {
    const codestream = bytes(0xff, 0x0a);
    expect(resolveMimeType(codestream).mimeType).toBe('image/jxl');

    const container = bytes(
      0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a,
    );
    expect(resolveMimeType(container).mimeType).toBe('image/jxl');
  });

  it('recognises a QOI header by magic number', () => {
    expect(resolveMimeType(ascii('qoif')).mimeType).toBe('image/qoi');
  });

  it('flags PDFs as recognised-but-unsupported rather than guessing', () => {
    const result = resolveMimeType(ascii('%PDF-1.7\n'), 'application/pdf', 'doc.pdf');
    expect(result).toEqual({
      mimeType: '',
      source: 'magic-number',
      unsupported: 'application/pdf',
    });
  });

  it('falls back to the declared type, ignoring parameters', () => {
    const result = resolveMimeType(bytes(0, 1, 2, 3), 'image/webp; charset=binary', '');
    expect(result).toEqual({ mimeType: 'image/webp', source: 'file-type' });
  });

  it('ignores a declared type that is not an image', () => {
    expect(resolveMimeType(bytes(0, 1, 2, 3), 'application/octet-stream', '')).toEqual({
      mimeType: '',
      source: 'unknown',
    });
  });

  it('falls back to the filename last', () => {
    expect(resolveMimeType(bytes(0, 1, 2, 3), '', 'holiday.AVIF')).toEqual({
      mimeType: 'image/avif',
      source: 'extension',
    });
  });

  it('detects SVG markup, with or without an XML prologue', () => {
    expect(resolveMimeType(ascii('<svg xmlns="...')).mimeType).toBe('image/svg+xml');
    expect(resolveMimeType(ascii('<?xml version="1.0"?><svg ')).mimeType).toBe(
      'image/svg+xml',
    );
  });

  it('gives up cleanly on an empty file', () => {
    expect(resolveMimeType(new Uint8Array(0), '', '')).toEqual({
      mimeType: '',
      source: 'unknown',
    });
  });
});

describe('isImageMimeType', () => {
  it('accepts every type in the extension table', () => {
    for (const mimeType of Object.keys(EXTENSION_BY_MIME)) {
      expect(isImageMimeType(mimeType)).toBe(true);
    }
  });

  it('rejects non-images and prototype keys', () => {
    expect(isImageMimeType('application/pdf')).toBe(false);
    expect(isImageMimeType('')).toBe(false);
    expect(isImageMimeType('toString')).toBe(false);
  });
});
