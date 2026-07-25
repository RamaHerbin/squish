/**
 * Named, shareable encoder settings.
 *
 * A preset is one side's settings, nothing more — no source image, no
 * dimensions. That keeps it applicable to any image and small enough to survive
 * a URL.
 *
 * Dependency-free: types and tiny pure helpers only.
 */

import { DEFAULT_ENCODER_OPTIONS, isEncoderId } from './codecs';
import type { SideSettings } from './processing';

/** Bump only on a breaking shape change; readers reject unknown versions. */
export const PRESET_VERSION = 1;

export interface Preset {
  /** Schema version. Always {@link PRESET_VERSION} for presets we write. */
  v: 1;
  /** Unique, user-facing. Doubles as the storage key. */
  name: string;
  /** The settings this preset applies to a side. */
  side: SideSettings;
}

/* -------------------------------------------------------------------------- */
/* Library                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * User's saved presets, persisted with `idb-keyval`.
 *
 * `presets` is reactive (`$state`-backed in the implementation) and is
 * populated asynchronously — it starts empty and fills once `ready` resolves.
 * Names are unique: saving over an existing name overwrites it.
 */
export interface PresetLibrary {
  /** Reactive, sorted by name. */
  readonly presets: readonly Preset[];
  /** Resolves once the initial load from IndexedDB has completed. */
  readonly ready: Promise<void>;

  get(name: string): Preset | undefined;
  /** Insert or overwrite. Returns the stored preset. */
  save(name: string, side: SideSettings): Promise<Preset>;
  /** No-op when `name` is unknown. */
  remove(name: string): Promise<void>;
  rename(oldName: string, newName: string): Promise<void>;
  /** Bulk insert, e.g. after importing a shared link. Overwrites by name. */
  import(presets: readonly Preset[]): Promise<void>;
  clear(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* URL encoding                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Query-string parameter carrying a shared preset, e.g.
 * `https://squish.app/?p=TOKEN`.
 */
export const PRESET_URL_PARAM = 'p';

/** The `CompressionStream` format the token is built with. */
export const PRESET_URL_COMPRESSION_FORMAT = 'deflate-raw';

/**
 * Token pipeline, in order:
 *
 * 1. `JSON.stringify(preset)`
 * 2. `new TextEncoder().encode(json)`
 * 3. through `new CompressionStream('deflate-raw')`
 * 4. {@link bytesToBase64Url}
 *
 * Decoding reverses it, then runs {@link isPreset} — the token comes from a URL
 * and is therefore untrusted input. `decode` rejects rather than returning a
 * half-valid preset.
 *
 * `deflate-raw` (no zlib/gzip framing) keeps typical tokens well under 300
 * chars, and base64url means no percent-encoding in the address bar.
 */
export interface PresetCodec {
  encode(preset: Preset): Promise<string>;
  decode(token: string): Promise<Preset>;
}

/** Standard base64 → base64url, unpadded. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Inverse of {@link bytesToBase64Url}. Throws on malformed input. */
export function base64UrlToBytes(token: string): Uint8Array {
  const base64 = token.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Encoder options are fed straight to wasm, so untrusted input must match the
 * selected encoder's default option shape exactly: no unknown keys, no type
 * changes, no non-finite numbers. Missing keys are fine — appliers merge over
 * defaults.
 */
function matchesEncoderOptionShape(
  options: Record<string, unknown>,
  defaults: Record<string, unknown>,
): boolean {
  for (const [key, incoming] of Object.entries(options)) {
    if (!(key in defaults)) return false;
    const expected = defaults[key];
    if (typeof incoming !== typeof expected) return false;
    if (typeof incoming === 'number' && !Number.isFinite(incoming)) return false;
  }
  return true;
}

/**
 * Loose structural check: the record is recognisably a {@link SideSettings}.
 * Use this before a *sanitizing rebuild* (settings persistence) — it accepts
 * junk keys and wrong-typed option values that the rebuild will drop.
 */
export function isSideSettingsShape(value: unknown): value is SideSettings {
  if (!isRecord(value)) return false;
  if (!isEncoderId(value['encoderId'])) return false;
  if (!isRecord(value['encoderOptions'])) return false;

  const processorState = value['processorState'];
  if (!isRecord(processorState)) return false;

  const resize = processorState['resize'];
  if (!isRecord(resize)) return false;
  if (typeof resize['enabled'] !== 'boolean') return false;
  if (typeof resize['width'] !== 'number' || typeof resize['height'] !== 'number') return false;
  if (typeof resize['method'] !== 'string') return false;

  return true;
}

/**
 * Strict check for {@link SideSettings} from *untrusted* input (shared URLs,
 * imported JSON): structure plus per-encoder option shape — options go
 * straight to wasm, so unknown keys, type changes and non-finite numbers are
 * all rejected rather than sanitized.
 */
export function isSideSettings(value: unknown): value is SideSettings {
  if (!isSideSettingsShape(value)) return false;
  const defaults = DEFAULT_ENCODER_OPTIONS[value.encoderId] as Record<string, unknown>;
  return matchesEncoderOptionShape(value.encoderOptions as Record<string, unknown>, defaults);
}

/**
 * Full validation for a decoded preset. Reject anything that fails — a shared
 * link is attacker-controllable, and encoder options are fed straight to wasm.
 */
export function isPreset(value: unknown): value is Preset {
  if (!isRecord(value)) return false;
  if (value['v'] !== PRESET_VERSION) return false;
  if (typeof value['name'] !== 'string' || value['name'].length === 0) return false;
  return isSideSettings(value['side']);
}
