/**
 * Preset serialization and URL sharing.
 *
 * Pure and dependency-free beyond the contracts themselves — no idb-keyval,
 * no Svelte, no DOM assumptions besides the standard `CompressionStream` /
 * `DecompressionStream` / `TextEncoder` / `atob`/`btoa` globals that both the
 * browser and modern Node provide. That keeps every function here directly
 * unit-testable.
 *
 * Token pipeline (mirrors the doc comment on `PresetCodec` in
 * `contracts/presets.ts`):
 *
 *   Preset --JSON.stringify--> string --TextEncoder--> bytes
 *         --CompressionStream('deflate-raw')--> bytes --base64url--> token
 *
 * Decoding reverses every step and finishes with {@link isPreset}, because a
 * token lifted from a URL is attacker-controlled and its `encoderOptions`
 * are fed straight to wasm encoders.
 */

import {
  PRESET_URL_COMPRESSION_FORMAT,
  PRESET_URL_PARAM,
  base64UrlToBytes,
  bytesToBase64Url,
  isPreset,
  type Preset,
  type PresetCodec,
} from '../contracts';

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** Thrown by {@link encodePresetToken} when the compressed token won't fit in a shareable URL. */
export class PresetTooLargeError extends Error {
  readonly tokenBytes: number;
  readonly limitBytes: number;

  constructor(tokenBytes: number, limitBytes: number) {
    super(`Preset token is ${tokenBytes} bytes, over the ${limitBytes} byte share limit.`);
    this.name = 'PresetTooLargeError';
    this.tokenBytes = tokenBytes;
    this.limitBytes = limitBytes;
  }
}

/** Thrown by {@link decodePresetToken} when a token is malformed or fails validation. */
export class PresetDecodeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PresetDecodeError';
  }
}

/* -------------------------------------------------------------------------- */
/* Size guard                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Hard ceiling on the base64url token length (ASCII, so this is also the
 * byte length). ~2KB keeps shared links well clear of practical URL length
 * limits across browsers and link-preview scrapers.
 */
export const MAX_PRESET_TOKEN_BYTES = 2048;

/** Ceiling for the decompressed JSON — far above any real preset. */
export const MAX_PRESET_JSON_BYTES = 64 * 1024;

/* -------------------------------------------------------------------------- */
/* Stream plumbing                                                             */
/* -------------------------------------------------------------------------- */

async function readAllChunks(
  readable: ReadableStream<Uint8Array>,
  maxBytes = Infinity,
): Promise<Uint8Array> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) {
      chunks.push(value);
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Decompressed payload exceeds ${maxBytes} bytes`);
      }
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function compressBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream(PRESET_URL_COMPRESSION_FORMAT);
  const writer = stream.writable.getWriter();
  // Fire-and-forget: the reader below drains the stream, so we don't await
  // write()/close() before starting to read (that would deadlock on
  // backpressure for larger payloads).
  const writeDone = writer.write(new Uint8Array(bytes)).then(() => writer.close());
  const [result] = await Promise.all([readAllChunks(stream.readable), writeDone]);
  return result;
}

async function decompressBytes(bytes: Uint8Array, maxBytes = Infinity): Promise<Uint8Array> {
  const stream = new DecompressionStream(PRESET_URL_COMPRESSION_FORMAT);
  const writer = stream.writable.getWriter();
  const writeDone = writer.write(new Uint8Array(bytes)).then(() => writer.close());
  // A rejected reader cancels the pipeline; silence the now-pointless write.
  const [result] = await Promise.all([
    readAllChunks(stream.readable, maxBytes),
    writeDone.catch(() => undefined),
  ]);
  return result;
}

/* -------------------------------------------------------------------------- */
/* Encode / decode                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Serializes a preset into a compact, URL-safe token.
 *
 * @throws {PresetTooLargeError} when the resulting token exceeds
 *   {@link MAX_PRESET_TOKEN_BYTES}.
 */
export async function encodePresetToken(preset: Preset): Promise<string> {
  const json = JSON.stringify(preset);
  const bytes = new TextEncoder().encode(json);
  const compressed = await compressBytes(bytes);
  const token = bytesToBase64Url(compressed);
  if (token.length > MAX_PRESET_TOKEN_BYTES) {
    throw new PresetTooLargeError(token.length, MAX_PRESET_TOKEN_BYTES);
  }
  return token;
}

/**
 * Inverse of {@link encodePresetToken}. Rejects rather than returning a
 * half-valid preset — `token` comes from a URL and is untrusted input.
 *
 * @throws {PresetDecodeError} when the token can't be decoded, decompressed,
 *   parsed as JSON, or fails {@link isPreset}.
 */
export async function decodePresetToken(token: string): Promise<Preset> {
  // Attacker-controlled input: bound it before touching it. The encoded cap
  // mirrors what encodePresetToken will ever produce; the decompressed cap
  // stops a tiny, highly-compressible token from ballooning in memory.
  if (token.length > MAX_PRESET_TOKEN_BYTES) {
    throw new PresetDecodeError(
      `Preset token is too large (${token.length} > ${MAX_PRESET_TOKEN_BYTES}).`,
    );
  }

  let compressed: Uint8Array;
  try {
    compressed = base64UrlToBytes(token);
  } catch (cause) {
    throw new PresetDecodeError('Preset token is not valid base64url.', { cause });
  }

  let bytes: Uint8Array;
  try {
    bytes = await decompressBytes(compressed, MAX_PRESET_JSON_BYTES);
  } catch (cause) {
    throw new PresetDecodeError('Preset token failed to decompress.', { cause });
  }

  let json: string;
  let parsed: unknown;
  try {
    json = new TextDecoder().decode(bytes);
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new PresetDecodeError('Preset token does not contain valid JSON.', { cause });
  }

  if (!isPreset(parsed)) {
    throw new PresetDecodeError('Preset token failed validation.');
  }
  return parsed;
}

/** {@link PresetCodec} implementation, ready to hand to anything typed against the contract. */
export const presetCodec: PresetCodec = {
  encode: encodePresetToken,
  decode: decodePresetToken,
};

/* -------------------------------------------------------------------------- */
/* URL sharing                                                                 */
/* -------------------------------------------------------------------------- */

/** Minimal shape of `Location` this module needs — easy to fake in tests. */
export interface LocationLike {
  href?: string;
  search: string;
  hash: string;
}

function currentLocation(): LocationLike {
  if (typeof location !== 'undefined') return location;
  return { href: undefined, search: '', hash: '' };
}

/**
 * Builds a full, shareable URL for `preset`.
 *
 * The contract documents {@link PRESET_URL_PARAM} as a query-string
 * parameter (`?p=TOKEN`), so that's the primary format written here; it's
 * also what {@link readPresetFromLocation} looks for first.
 *
 * @param base Defaults to the current page URL. Pass an explicit value in
 *   non-browser contexts (tests, SSR).
 */
export async function buildPresetShareUrl(
  preset: Preset,
  base: string | URL = currentLocation().href ?? 'http://localhost/',
): Promise<string> {
  const token = await encodePresetToken(preset);
  const url = new URL(base);
  url.searchParams.set(PRESET_URL_PARAM, token);
  return url.toString();
}

function extractPresetToken(loc: LocationLike): string | null {
  const fromQuery = new URLSearchParams(loc.search).get(PRESET_URL_PARAM);
  if (fromQuery) return fromQuery;

  // Fallback: also accept the same param carried in the hash fragment
  // (`#p=TOKEN`, or `#/route?p=TOKEN`), for deployments that prefer to keep
  // the token out of the query string entirely.
  const hash = loc.hash.startsWith('#') ? loc.hash.slice(1) : loc.hash;
  const queryIndex = hash.indexOf('?');
  const hashQuery = queryIndex >= 0 ? hash.slice(queryIndex + 1) : hash;
  return new URLSearchParams(hashQuery).get(PRESET_URL_PARAM);
}

/**
 * On-load hook: parses the current location for a shared preset token and
 * decodes it. Returns `null` (never throws) when there is no token, or when
 * the token is malformed/untrusted-invalid — callers don't need a try/catch.
 *
 * Pass `loc` explicitly in tests; defaults to the global `location`.
 */
export async function readPresetFromLocation(
  loc: LocationLike = currentLocation(),
): Promise<Preset | null> {
  const token = extractPresetToken(loc);
  if (!token) return null;
  try {
    return await decodePresetToken(token);
  } catch {
    return null;
  }
}
