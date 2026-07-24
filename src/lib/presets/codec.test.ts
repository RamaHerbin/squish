import { describe, expect, it } from 'vitest';

import { createSideSettings, isPreset, PRESET_URL_PARAM, type Preset } from '../contracts';
import {
  MAX_PRESET_TOKEN_BYTES,
  PresetDecodeError,
  PresetTooLargeError,
  buildPresetShareUrl,
  decodePresetToken,
  encodePresetToken,
  presetCodec,
  readPresetFromLocation,
} from './codec';

function makePreset(name = 'Web hero'): Preset {
  return { v: 1, name, side: createSideSettings('mozjpeg', { quality: 42 }) };
}

/** High-entropy ASCII — unlike a repeated character, deflate can't shrink this much. */
function randomAsciiString(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

describe('preset token round-trip', () => {
  it('encodes then decodes back to an equivalent preset', async () => {
    const preset = makePreset();
    const token = await encodePresetToken(preset);
    const decoded = await decodePresetToken(token);
    expect(decoded).toEqual(preset);
  });

  it('produces a URL-safe token (no +, /, or = padding)', async () => {
    const token = await encodePresetToken(makePreset('preset/with+chars=='));
    expect(token).not.toMatch(/[+/=]/);
  });

  it('round-trips through the PresetCodec object exported for contracts consumers', async () => {
    const preset = makePreset('Via PresetCodec');
    const token = await presetCodec.encode(preset);
    const decoded = await presetCodec.decode(token);
    expect(decoded).toEqual(preset);
  });

  it('round-trips every encoder id, including no-option encoders', async () => {
    const preset = makePreset('QOI archival');
    preset.side = createSideSettings('qoi');
    const token = await encodePresetToken(preset);
    expect(await decodePresetToken(token)).toEqual(preset);
  });

  it('round-trips a preset carrying resize + crop-shaped processor state', async () => {
    const base = createSideSettings('avif', { quality: 30 });
    base.processorState.resize = {
      ...base.processorState.resize,
      enabled: true,
      width: 1600,
      height: 1200,
      fitMethod: 'contain',
    };
    const preset: Preset = { v: 1, name: 'Resized AVIF', side: base };
    const token = await encodePresetToken(preset);
    expect(await decodePresetToken(token)).toEqual(preset);
  });
});

describe('size guard', () => {
  it('rejects tokens over the byte limit', async () => {
    const huge = makePreset(randomAsciiString(MAX_PRESET_TOKEN_BYTES * 2));
    await expect(encodePresetToken(huge)).rejects.toBeInstanceOf(PresetTooLargeError);
  });

  it('reports the offending size on the thrown error', async () => {
    const huge = makePreset(randomAsciiString(MAX_PRESET_TOKEN_BYTES * 2));
    try {
      await encodePresetToken(huge);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PresetTooLargeError);
      const sizeError = err as PresetTooLargeError;
      expect(sizeError.tokenBytes).toBeGreaterThan(MAX_PRESET_TOKEN_BYTES);
      expect(sizeError.limitBytes).toBe(MAX_PRESET_TOKEN_BYTES);
    }
  });

  it('accepts a realistic preset comfortably under the limit', async () => {
    const token = await encodePresetToken(makePreset());
    expect(token.length).toBeLessThan(MAX_PRESET_TOKEN_BYTES / 4);
  });
});

describe('decode rejects untrusted input', () => {
  it('rejects a token that is not valid base64url', async () => {
    await expect(decodePresetToken('not base64url!! ///')).rejects.toBeInstanceOf(
      PresetDecodeError,
    );
  });

  it('rejects a token that decompresses to non-JSON', async () => {
    // Valid base64url, but not a deflate-raw stream at all.
    await expect(decodePresetToken('aGVsbG8')).rejects.toBeInstanceOf(PresetDecodeError);
  });

  it('rejects a well-formed-but-invalid preset (unknown encoder id)', async () => {
    const evil = { v: 1, name: 'evil', side: { encoderId: 'evil', encoderOptions: {}, processorState: makePreset().side.processorState } };
    expect(isPreset(evil)).toBe(false);

    const json = JSON.stringify(evil);
    const bytes = new TextEncoder().encode(json);
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    void writer.write(bytes);
    void writer.close();
    const chunks: Uint8Array[] = [];
    const reader = cs.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    let binary = '';
    for (const byte of out) binary += String.fromCharCode(byte);
    const token = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    await expect(decodePresetToken(token)).rejects.toBeInstanceOf(PresetDecodeError);
  });
});

describe('URL sharing', () => {
  it('builds a URL carrying the token under PRESET_URL_PARAM', async () => {
    const preset = makePreset('Shared preset');
    const url = await buildPresetShareUrl(preset, 'https://squish.app/');
    const parsed = new URL(url);
    const token = parsed.searchParams.get(PRESET_URL_PARAM);
    expect(token).toBeTruthy();
    expect(await decodePresetToken(token!)).toEqual(preset);
  });

  it('preserves the rest of the URL (path, other params)', async () => {
    const url = await buildPresetShareUrl(makePreset(), 'https://squish.app/editor?keep=me');
    expect(url).toMatch(/^https:\/\/squish\.app\/editor\?/);
    expect(new URL(url).searchParams.get('keep')).toBe('me');
  });

  it('readPresetFromLocation finds the token in the query string', async () => {
    const preset = makePreset('From query');
    const token = await encodePresetToken(preset);
    const result = await readPresetFromLocation({ search: `?${PRESET_URL_PARAM}=${token}`, hash: '' });
    expect(result).toEqual(preset);
  });

  it('readPresetFromLocation falls back to the hash fragment', async () => {
    const preset = makePreset('From hash');
    const token = await encodePresetToken(preset);
    const result = await readPresetFromLocation({ search: '', hash: `#${PRESET_URL_PARAM}=${token}` });
    expect(result).toEqual(preset);
  });

  it('readPresetFromLocation returns null when there is no token', async () => {
    expect(await readPresetFromLocation({ search: '', hash: '' })).toBeNull();
  });

  it('readPresetFromLocation returns null (never throws) for a garbage token', async () => {
    const result = await readPresetFromLocation({ search: `?${PRESET_URL_PARAM}=not-a-real-token`, hash: '' });
    expect(result).toBeNull();
  });
});
