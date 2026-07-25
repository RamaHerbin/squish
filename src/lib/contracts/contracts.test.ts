import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ENCODER_OPTIONS,
  ENCODER_IDS,
  createDefaultSideSettings,
  createSideSettings,
  dedupeFilename,
  defaultOptionsFor,
  getContainOffsets,
  heightForWidth,
  isEncoderId,
  isPreset,
  isSideSettingsFor,
  mimeTypeFromFilename,
  preprocessorStateEqual,
  processorStateEqual,
  progressFraction,
  replaceExtension,
  shallowEqual,
  sideSettingsEqual,
  sniffMimeTypeFromBytes,
  widthForHeight,
  withEncoder,
  type BatchProgress,
  type EncoderId,
  type EncoderMeta,
  type EncoderModule,
  type EncoderRegistry,
  type SideSettings,
  type WorkerApi,
} from './index';

/* -------------------------------------------------------------------------- */
/* Compile-time contracts                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Never called — it exists so `tsc`/`svelte-check` verify these shapes.
 * A missing registry key or a mistyped encoder option fails the build here.
 */
function __compileTimeAssertions(
  meta: <K extends EncoderId>(id: K) => EncoderMeta<K>,
  api: WorkerApi,
): void {
  // The registry must be exhaustive: dropping a key is a compile error.
  const registry: EncoderRegistry = {
    avif: meta('avif'),
    jxl: meta('jxl'),
    webp: meta('webp'),
    mozjpeg: meta('mozjpeg'),
    oxipng: meta('oxipng'),
    qoi: meta('qoi'),
    'browser-png': meta('browser-png'),
    'browser-jpeg': meta('browser-jpeg'),
    'browser-webp': meta('browser-webp'),
    identity: meta('identity'),
  };
  void registry;

  // `options` narrows from the module's own type parameter.
  const mod: EncoderModule<'mozjpeg'> = {
    meta: meta('mozjpeg'),
    async encode(_signal, _data, options) {
      void options.quality;
      return new ArrayBuffer(0);
    },
  };
  void mod;

  // `WorkerApi.encode` ties `options` to the encoder id.
  const payload = { data: new Uint8ClampedArray(4), width: 1, height: 1 };
  void api.encode('mozjpeg', payload, DEFAULT_ENCODER_OPTIONS.mozjpeg);
  void api.encode('qoi', payload, {});
}
void __compileTimeAssertions;

/* -------------------------------------------------------------------------- */

describe('mime sniffing', () => {
  const bytesOf = (...values: number[]) => new Uint8Array(values);
  const latin1 = (text: string) =>
    new Uint8Array(Array.from(text, (char) => char.charCodeAt(0)));

  it('detects PNG by magic number', () => {
    expect(sniffMimeTypeFromBytes(bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(
      'image/png',
    );
  });

  it('detects JPEG, GIF and QOI', () => {
    expect(sniffMimeTypeFromBytes(bytesOf(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffMimeTypeFromBytes(latin1('GIF89a'))).toBe('image/gif');
    expect(sniffMimeTypeFromBytes(latin1('qoif'))).toBe('image/qoi');
  });

  it('detects WebP only with a full RIFF header', () => {
    expect(sniffMimeTypeFromBytes(latin1('RIFF????WEBPVP8 '))).toBe('image/webp');
    expect(sniffMimeTypeFromBytes(latin1('RIFF????WAVEfmt '))).toBe('');
  });

  it('detects HEIC/HEIF by ftyp major brand, without stealing AVIF', () => {
    // 4-byte box size is arbitrary; the brand sits at offset 8.
    expect(sniffMimeTypeFromBytes(latin1('\x00\x00\x00\x18ftypheic\x00\x00\x00\x00'))).toBe(
      'image/heic',
    );
    expect(sniffMimeTypeFromBytes(latin1('\x00\x00\x00\x18ftyphevx\x00\x00\x00\x00'))).toBe(
      'image/heic',
    );
    expect(sniffMimeTypeFromBytes(latin1('\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00'))).toBe(
      'image/heif',
    );
    expect(sniffMimeTypeFromBytes(latin1('\x00\x00\x00 ftypavif\x00\x00\x00\x00'))).toBe(
      'image/avif',
    );
    expect(sniffMimeTypeFromBytes(latin1('\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00'))).toBe('');
  });

  it('recognises SVG markup with and without an XML prolog', () => {
    expect(sniffMimeTypeFromBytes(latin1('<svg xmlns="x">'))).toBe('image/svg+xml');
    expect(sniffMimeTypeFromBytes(latin1('<?xml version="1.0"?><svg '))).toBe('image/svg+xml');
  });

  it('flags PDFs so they can be rejected with a real message', () => {
    expect(sniffMimeTypeFromBytes(latin1('%PDF-1.7'))).toBe('application/pdf');
  });

  it('returns empty for unknown bytes', () => {
    expect(sniffMimeTypeFromBytes(bytesOf(1, 2, 3, 4))).toBe('');
  });

  it('falls back to the filename', () => {
    expect(mimeTypeFromFilename('holiday.JPEG')).toBe('image/jpeg');
    expect(mimeTypeFromFilename('archive.tar.gz')).toBe('');
    expect(mimeTypeFromFilename('noextension')).toBe('');
  });

  it('replaces extensions, adding one when absent', () => {
    expect(replaceExtension('photo.png', 'webp')).toBe('photo.webp');
    expect(replaceExtension('my.photo.png', 'avif')).toBe('my.photo.avif');
    expect(replaceExtension('photo', 'jxl')).toBe('photo.jxl');
  });
});

describe('encoder defaults', () => {
  it('covers every encoder id', () => {
    for (const id of ENCODER_IDS) {
      expect(DEFAULT_ENCODER_OPTIONS[id]).toBeDefined();
    }
    expect(Object.keys(DEFAULT_ENCODER_OPTIONS).sort()).toEqual([...ENCODER_IDS].sort());
  });

  it('hands out fresh copies so $state cannot poison the defaults', () => {
    const options = defaultOptionsFor('mozjpeg');
    options.quality = 10;
    expect(DEFAULT_ENCODER_OPTIONS.mozjpeg.quality).toBe(75);
  });

  it('guards unknown encoder ids', () => {
    expect(isEncoderId('mozjpeg')).toBe(true);
    expect(isEncoderId('mozJPEG')).toBe(false);
    expect(isEncoderId(null)).toBe(false);
  });
});

describe('side settings', () => {
  it('defaults to identity on the left and mozjpeg on the right', () => {
    expect(createDefaultSideSettings(0).encoderId).toBe('identity');
    expect(createDefaultSideSettings(1).encoderId).toBe('mozjpeg');
  });

  it('narrows encoder options on the discriminant', () => {
    const settings: SideSettings = createSideSettings('avif', { quality: 40 });
    expect(isSideSettingsFor(settings, 'avif')).toBe(true);
    if (isSideSettingsFor(settings, 'avif')) {
      expect(settings.encoderOptions.quality).toBe(40);
      expect(settings.encoderOptions.speed).toBe(6);
    }
  });

  it('keeps the resize config when swapping encoders', () => {
    const base = createSideSettings('mozjpeg');
    base.processorState.resize = { ...base.processorState.resize, enabled: true, width: 800 };
    const swapped = withEncoder(base, 'webp');

    expect(swapped.encoderId).toBe('webp');
    expect(swapped.processorState.resize.width).toBe(800);
    // Cloned, not aliased — mutating one side must not leak into the other.
    expect(swapped.processorState).not.toBe(base.processorState);
  });
});

describe('equality helpers', () => {
  it('compares one level deep', () => {
    expect(shallowEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(shallowEqual({ a: { n: 1 } }, { a: { n: 1 } })).toBe(false);
  });

  it('treats two disabled resizes as equivalent regardless of stale values', () => {
    const a = createSideSettings('webp');
    const b = createSideSettings('webp');
    b.processorState.resize = { ...b.processorState.resize, width: 4000, height: 3000 };

    expect(a.processorState.resize.enabled).toBe(false);
    expect(processorStateEqual(a.processorState, b.processorState)).toBe(true);
    expect(sideSettingsEqual(a, b)).toBe(true);
  });

  it('sees a difference once resize is switched on', () => {
    const a = createSideSettings('webp');
    const b = createSideSettings('webp');
    b.processorState.resize = { ...b.processorState.resize, enabled: true, width: 100 };
    expect(processorStateEqual(a.processorState, b.processorState)).toBe(false);
  });

  it('distinguishes encoders and their options', () => {
    expect(sideSettingsEqual(createSideSettings('webp'), createSideSettings('avif'))).toBe(false);
    expect(
      sideSettingsEqual(createSideSettings('webp'), createSideSettings('webp', { quality: 10 })),
    ).toBe(false);
  });

  it('compares preprocessor state including the optional crop', () => {
    expect(preprocessorStateEqual({ rotate: 90 }, { rotate: 90 })).toBe(true);
    expect(preprocessorStateEqual({ rotate: 90 }, { rotate: 180 })).toBe(false);
    expect(
      preprocessorStateEqual({ rotate: 0, crop: { x: 0, y: 0, width: 5, height: 5 } }, { rotate: 0 }),
    ).toBe(false);
    expect(
      preprocessorStateEqual(
        { rotate: 0, crop: { x: 0, y: 0, width: 5, height: 5 } },
        { rotate: 0, crop: { x: 0, y: 0, width: 5, height: 5 } },
      ),
    ).toBe(true);
  });
});

describe('geometry', () => {
  it('centre-crops the wider axis for contain', () => {
    expect(getContainOffsets(200, 100, 50, 50)).toEqual({ sx: 50, sy: 0, sw: 100, sh: 100 });
    expect(getContainOffsets(100, 200, 50, 50)).toEqual({ sx: 0, sy: 50, sw: 100, sh: 100 });
  });

  it('preserves aspect ratio in both directions', () => {
    expect(heightForWidth(1000, 500, 400)).toBe(200);
    expect(widthForHeight(1000, 500, 200)).toBe(400);
    expect(heightForWidth(1000, 500, 1)).toBe(1);
  });
});

describe('presets', () => {
  const validPreset = { v: 1, name: 'Web hero', side: createSideSettings('mozjpeg') };

  it('accepts a well-formed preset', () => {
    expect(isPreset(validPreset)).toBe(true);
  });

  it('rejects untrusted junk from a shared URL', () => {
    expect(isPreset(null)).toBe(false);
    expect(isPreset({ ...validPreset, v: 2 })).toBe(false);
    expect(isPreset({ ...validPreset, name: '' })).toBe(false);
    expect(isPreset({ ...validPreset, side: { ...validPreset.side, encoderId: 'evil' } })).toBe(
      false,
    );
    expect(isPreset({ ...validPreset, side: { encoderId: 'webp', encoderOptions: {} } })).toBe(
      false,
    );
  });
});

describe('batch helpers', () => {
  it('suffixes colliding filenames before the extension', () => {
    const used = new Set<string>();
    expect(dedupeFilename('photo.webp', used)).toBe('photo.webp');
    expect(dedupeFilename('photo.webp', used)).toBe('photo (2).webp');
    expect(dedupeFilename('photo.webp', used)).toBe('photo (3).webp');
    expect(dedupeFilename('noext', used)).toBe('noext');
    expect(dedupeFilename('noext', used)).toBe('noext (2)');
  });

  it('reports progress over settled items and treats empty as complete', () => {
    const progress: BatchProgress = {
      total: 4,
      done: 2,
      errored: 1,
      processing: 1,
      running: true,
      bytesIn: 0,
      bytesOut: 0,
    };
    expect(progressFraction(progress)).toBe(0.75);
    expect(progressFraction({ ...progress, total: 0, done: 0, errored: 0 })).toBe(1);
  });
});
