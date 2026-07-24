/**
 * Encoders backed by the browser itself (`canvas.toBlob` / `convertToBlob`).
 *
 * They are worth keeping around next to the wasm codecs: they are essentially
 * free (no download, no wasm instantiation), they are what a native "Save as…"
 * would produce, and they give a useful baseline to compare MozJPEG/OxiPNG
 * against. What they are not is configurable — one `quality` number, and only
 * for the lossy ones.
 *
 * These run on the calling thread. Called from the main thread on a large image
 * they will block it; the job engine is expected to keep them off the critical
 * path or run them from a worker realm (an `OffscreenCanvas` is used
 * automatically when there is no `document`).
 */

import {
  abortable,
  assertSignal,
  type AnyEncoderOptions,
  type BrowserEncoderId,
  type BrowserQualityOptions,
  type EncoderMeta,
  type EncoderModule,
  type ImageMimeType,
} from '../contracts';
import { canEncodeImageType } from './capabilities';
import { canvasEncode } from './canvas';
import { ENCODER_REGISTRY } from './registry';

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/** Output MIME type of each browser encoder. */
export const BROWSER_ENCODER_MIME: Readonly<Record<BrowserEncoderId, ImageMimeType>> = {
  'browser-png': 'image/png',
  'browser-jpeg': 'image/jpeg',
  'browser-webp': 'image/webp',
};

export function isBrowserEncoderId(value: unknown): value is BrowserEncoderId {
  return (
    value === 'browser-png' || value === 'browser-jpeg' || value === 'browser-webp'
  );
}

/* -------------------------------------------------------------------------- */
/* Encoding                                                                    */
/* -------------------------------------------------------------------------- */

/** Pull a canvas-shaped (0–1) quality out of whichever option bag we were given. */
function qualityOf(options: AnyEncoderOptions): number | undefined {
  const quality = (options as Partial<BrowserQualityOptions>).quality;
  return typeof quality === 'number' ? quality : undefined;
}

/**
 * Encode with the browser's own encoder.
 *
 * PNG ignores quality entirely — passing one makes Chrome log a warning, so it
 * is dropped here rather than forwarded.
 */
export async function browserEncode(
  signal: AbortSignal,
  id: BrowserEncoderId,
  data: ImageData,
  options: AnyEncoderOptions,
): Promise<ArrayBuffer> {
  assertSignal(signal);

  const mimeType = BROWSER_ENCODER_MIME[id];
  const quality = id === 'browser-png' ? undefined : qualityOf(options);
  const blob = await abortable(signal, canvasEncode(data, mimeType, quality));

  if (blob.type !== mimeType) {
    throw new Error(`This browser cannot encode ${mimeType}`);
  }

  return abortable(signal, blob.arrayBuffer());
}

/* -------------------------------------------------------------------------- */
/* Encoder modules                                                             */
/* -------------------------------------------------------------------------- */

/** Build the {@link EncoderModule} for one of the `browser-*` encoders. */
export function createBrowserEncoderModule<K extends BrowserEncoderId>(
  id: K,
): EncoderModule<K> {
  const meta = ENCODER_REGISTRY[id] as EncoderMeta<K>;
  return {
    meta,
    encode: (signal, data, options) => browserEncode(signal, id, data, options),
    featureTest: () => canEncodeImageType(BROWSER_ENCODER_MIME[id]),
  };
}

/**
 * The `identity` "encoder" — a marker, not an implementation.
 *
 * `identity` means "hand the original file back untouched", which the job
 * engine has to special-case anyway (it has the `File`; this layer only ever
 * sees pixels, and re-encoding them would defeat the entire point). Calling
 * `encode` is therefore always a bug, and says so.
 */
export const identityEncoderModule: EncoderModule<'identity'> = {
  meta: ENCODER_REGISTRY.identity,
  encode() {
    return Promise.reject(
      new Error(
        'The identity encoder passes the source file through — handle it before dispatching to an encoder',
      ),
    );
  },
  featureTest: () => Promise.resolve(true),
};
