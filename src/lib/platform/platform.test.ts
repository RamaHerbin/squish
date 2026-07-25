// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  basenameOf,
  extensionOf,
  isTauri,
  mimeTypeForPath,
  messageOf,
  initPlatform,
  sanitizeSuggestedName,
  saveBlob,
  saveFiltersFor,
} from './index';

/**
 * Only `./index.ts` is imported here, never `./tauri.ts` — the whole point of
 * the seam is that the native module stays out of any graph that has not
 * checked `isTauri()` first. Vitest runs in node, where a `@tauri-apps` import
 * would resolve but every call would throw.
 */

/* -------------------------------------------------------------------------- */
/* Path helpers                                                                */
/* -------------------------------------------------------------------------- */

describe('basenameOf', () => {
  it('takes the last segment of an absolute macOS path', () => {
    expect(basenameOf('/Users/x/Desktop/a.heic')).toBe('a.heic');
    expect(basenameOf('/Volumes/Photos/2024/beach shot.jpg')).toBe('beach shot.jpg');
  });

  it('passes a bare filename through', () => {
    expect(basenameOf('photo.png')).toBe('photo.png');
  });

  it('treats a backslash as a separator too', () => {
    expect(basenameOf('folder\\photo.png')).toBe('photo.png');
  });

  it('is empty for a trailing separator', () => {
    expect(basenameOf('/Users/x/')).toBe('');
  });
});

describe('extensionOf', () => {
  it('lower-cases and drops the dot', () => {
    expect(extensionOf('holiday.JPEG')).toBe('jpeg');
    expect(extensionOf('shot.AVIF')).toBe('avif');
  });

  it('uses the last extension only', () => {
    expect(extensionOf('archive.tar.gz')).toBe('gz');
  });

  it('is empty when there is no extension', () => {
    expect(extensionOf('noextension')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
  });

  it('does not treat a hidden file as an extension', () => {
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('/Users/x/.gitignore')).toBe('');
  });

  it('ignores an extension that belongs to a directory', () => {
    expect(extensionOf('/Users/x/photos.2024/beach')).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* Suggested-name sanitisation                                                 */
/* -------------------------------------------------------------------------- */

describe('sanitizeSuggestedName', () => {
  it('leaves an ordinary filename alone', () => {
    expect(sanitizeSuggestedName('beach.avif')).toBe('beach.avif');
    expect(sanitizeSuggestedName('squished.zip')).toBe('squished.zip');
  });

  it('keeps only the last segment so the dialog cannot be pointed at a folder', () => {
    expect(sanitizeSuggestedName('holiday/2024/beach.webp')).toBe('beach.webp');
    expect(sanitizeSuggestedName('/etc/passwd.png')).toBe('passwd.png');
  });

  it('replaces the legacy macOS path separator', () => {
    expect(sanitizeSuggestedName('12:30 shot.png')).toBe('12-30 shot.png');
  });

  it('strips control characters', () => {
    expect(sanitizeSuggestedName('be\u0000ach\u001F.png')).toBe('beach.png');
  });

  it('collapses runs of whitespace and trims the ends', () => {
    expect(sanitizeSuggestedName('  beach   shot.png  ')).toBe('beach shot.png');
  });

  it('falls back when nothing usable survives', () => {
    expect(sanitizeSuggestedName('')).toBe('image');
    expect(sanitizeSuggestedName('   ')).toBe('image');
    expect(sanitizeSuggestedName('.')).toBe('image');
    expect(sanitizeSuggestedName('..')).toBe('image');
    expect(sanitizeSuggestedName('/')).toBe('image');
    expect(sanitizeSuggestedName('', 'squished.zip')).toBe('squished.zip');
  });

  it('truncates the stem but never the extension', () => {
    const long = `${'a'.repeat(400)}.avif`;
    const result = sanitizeSuggestedName(long);
    expect(result.length).toBe(255);
    expect(result.endsWith('.avif')).toBe(true);
  });

  it('truncates a long extensionless name to the filesystem limit', () => {
    expect(sanitizeSuggestedName('b'.repeat(400))).toHaveLength(255);
  });
});

/* -------------------------------------------------------------------------- */
/* Save filters                                                                */
/* -------------------------------------------------------------------------- */

describe('saveFiltersFor', () => {
  it('labels the formats Pinch writes', () => {
    expect(saveFiltersFor('beach.avif')).toEqual([{ name: 'AVIF', extensions: ['avif'] }]);
    expect(saveFiltersFor('beach.webp')).toEqual([{ name: 'WebP', extensions: ['webp'] }]);
    expect(saveFiltersFor('beach.jxl')).toEqual([{ name: 'JPEG XL', extensions: ['jxl'] }]);
    expect(saveFiltersFor('squished.zip')).toEqual([{ name: 'ZIP archive', extensions: ['zip'] }]);
  });

  it('offers both spellings of a format family', () => {
    expect(saveFiltersFor('beach.jpg')).toEqual([{ name: 'JPEG', extensions: ['jpg', 'jpeg'] }]);
    expect(saveFiltersFor('beach.jpeg')).toEqual([{ name: 'JPEG', extensions: ['jpg', 'jpeg'] }]);
    expect(saveFiltersFor('scan.tiff')).toEqual([{ name: 'TIFF', extensions: ['tif', 'tiff'] }]);
  });

  it('upper-cases an extension it has no label for', () => {
    expect(saveFiltersFor('data.xyz')).toEqual([{ name: 'XYZ', extensions: ['xyz'] }]);
  });

  it('is empty without an extension, so the dialog stays unfiltered', () => {
    expect(saveFiltersFor('noextension')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* MIME from path                                                              */
/* -------------------------------------------------------------------------- */

describe('mimeTypeForPath', () => {
  it('maps every extension the intake accepts', () => {
    expect(mimeTypeForPath('/Users/x/a.png')).toBe('image/png');
    expect(mimeTypeForPath('/Users/x/a.jpg')).toBe('image/jpeg');
    expect(mimeTypeForPath('/Users/x/a.jpeg')).toBe('image/jpeg');
    expect(mimeTypeForPath('/Users/x/a.jpe')).toBe('image/jpeg');
    expect(mimeTypeForPath('/Users/x/a.webp')).toBe('image/webp');
    expect(mimeTypeForPath('/Users/x/a.avif')).toBe('image/avif');
    expect(mimeTypeForPath('/Users/x/a.jxl')).toBe('image/jxl');
    expect(mimeTypeForPath('/Users/x/a.gif')).toBe('image/gif');
    expect(mimeTypeForPath('/Users/x/a.bmp')).toBe('image/bmp');
    expect(mimeTypeForPath('/Users/x/a.tif')).toBe('image/tiff');
    expect(mimeTypeForPath('/Users/x/a.tiff')).toBe('image/tiff');
    expect(mimeTypeForPath('/Users/x/a.qoi')).toBe('image/qoi');
    expect(mimeTypeForPath('/Users/x/a.heic')).toBe('image/heic');
    expect(mimeTypeForPath('/Users/x/a.heif')).toBe('image/heif');
    expect(mimeTypeForPath('/Users/x/a.svg')).toBe('image/svg+xml');
  });

  it('is case-insensitive, the way Finder is', () => {
    expect(mimeTypeForPath('/Users/x/IMG_0001.HEIC')).toBe('image/heic');
  });

  it('is empty for anything it does not recognise', () => {
    expect(mimeTypeForPath('/Users/x/notes.txt')).toBe('');
    expect(mimeTypeForPath('/Users/x/noextension')).toBe('');
  });

  it('is not fooled by a dot in a parent directory', () => {
    expect(mimeTypeForPath('/Users/x/photos.png/README')).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* Detection + web behaviour                                                   */
/* -------------------------------------------------------------------------- */

describe('isTauri', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri;
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('is false in a plain browser', () => {
    expect(isTauri()).toBe(false);
  });

  it('follows the global the Tauri API itself reads', () => {
    (globalThis as Record<string, unknown>).isTauri = true;
    expect(isTauri()).toBe(true);
  });

  it('also accepts the IPC bridge global', () => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: () => {} };
    expect(isTauri()).toBe(true);
  });
});

describe('saveBlob on the web', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('clicks a throwaway object-URL anchor, synchronously', () => {
    const createObjectURL = vi.fn(() => 'blob:pinch/1');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

    let clicked: HTMLAnchorElement | undefined;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked = this;
      });

    // Not awaited on purpose: the anchor must be clicked in the same task as
    // the user gesture, so `saveBlob` may not await anything before it.
    void saveBlob('beach.avif', new Blob(['x']));

    expect(click).toHaveBeenCalledOnce();
    expect(clicked?.getAttribute('href')).toBe('blob:pinch/1');
    expect(clicked?.getAttribute('download')).toBe('beach.avif');
    expect(clicked?.getAttribute('rel')).toBe('noopener');
    expect(createObjectURL).toHaveBeenCalledOnce();
    // The anchor is removed again; nothing is left in the document.
    expect(document.body.querySelector('a')).toBeNull();

    vi.unstubAllGlobals();
  });

  it('passes the suggested name through untouched, exactly as before', async () => {
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:pinch/2', revokeObjectURL() {} });
    let name: string | null | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      name = this.getAttribute('download');
    });

    await saveBlob('holiday/2024/beach.webp', new Blob(['x']));

    expect(name).toBe('holiday/2024/beach.webp');
    vi.unstubAllGlobals();
  });

  it('reports saved', async () => {
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:pinch/3', revokeObjectURL() {} });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await expect(saveBlob('beach.avif', new Blob(['x']))).resolves.toBe('saved');
    vi.unstubAllGlobals();
  });
});

describe('initPlatform on the web', () => {
  it('subscribes to nothing and disposes cleanly', () => {
    const onFiles = vi.fn();
    const dispose = initPlatform({ onFiles });
    expect(onFiles).not.toHaveBeenCalled();
    expect(() => dispose()).not.toThrow();
  });
});

describe('messageOf', () => {
  it('unwraps an Error', () => {
    expect(messageOf(new Error('forbidden path'))).toBe('forbidden path');
  });

  it('passes a bare string through, which is what Tauri IPC rejects with', () => {
    expect(messageOf('fs.read_file not allowed')).toBe('fs.read_file not allowed');
  });

  it('has a fallback for anything else', () => {
    expect(messageOf({ code: 12 })).toBe('Something went wrong.');
  });
});
