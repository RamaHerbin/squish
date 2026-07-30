/**
 * The PDF recompression orchestrator: wire analysis → plan → decode → encode →
 * rewrite into one `ArrayBuffer -> ArrayBuffer` job.
 *
 * It is the only module in the layer that owns a codec bridge. Everything heavy
 * (JPEG decode, MozJPEG encode) is delegated to that bridge's worker; pdf-lib
 * parsing and stream rewriting run here on the calling thread. There is no
 * dedicated PDF worker — the codec worker already absorbs the CPU cost, and the
 * per-image loop is naturally sequential.
 *
 * Testability is bought with injectable deps: the pixel-touching steps
 * (`decodeImageData`, `resampleImageData`) and the bridge itself default to the
 * real browser implementations but can be replaced with fakes, so the whole
 * orchestration — skip gating, replace-if-smaller, dedupe/strip, refusal
 * passthrough — is exercised in Node with no canvas and no worker.
 */

import { PDFDocument, PDFRawStream, PDFRef } from '@cantoo/pdf-lib';

import { createWorkerBridge } from '../codecs';
import { DEFAULT_ENCODER_OPTIONS, isAbortError } from '../contracts';
import type {
  PdfCompressResult,
  PdfCompressSettings,
  PdfImageInfo,
  PdfImageOutcome,
  WorkerBridgeApi,
} from '../contracts';
import { measureSsim } from '../metrics';

import { analyzePdf } from './analyze';
import { decodePdfImageData, resampleImageData, type PdfDecodeDeps } from './decode';
import { imageSkipReason, resampleTarget } from './plan';
import { dedupeImages, replaceImageStream, stripMetadata } from './rewrite';

/**
 * Everything the orchestrator needs that it should not hard-wire.
 *
 * All optional: the browser gets the real implementations by default, tests pass
 * fakes. An **injected** bridge is left alone; an owned one (created here because
 * none was passed) is always terminated in `finally`.
 */
export interface PdfCompressDeps {
  readonly bridge?: WorkerBridgeApi;
  readonly signal?: AbortSignal;
  /** Called once per image after it is resolved (skipped, replaced or errored). */
  readonly onProgress?: (done: number, total: number) => void;
  /** Defaults to `decodePdfImageData` (browser). Inject a fake in Node tests. */
  readonly decodeImageData?: (
    deps: PdfDecodeDeps,
    stream: PDFRawStream,
    info: PdfImageInfo,
  ) => Promise<ImageData>;
  /** Defaults to `resampleImageData` (canvas). Inject a fake in Node tests. */
  readonly resampleImageData?: (
    data: ImageData,
    size: { width: number; height: number },
  ) => ImageData;
}

/**
 * Recompress every eligible image in a PDF and return the rebuilt document.
 *
 * A refused document (encrypted, signed, unreadable) is returned byte-for-byte
 * unchanged, with no images and no bridge created. Otherwise each image is
 * skip-gated, decoded, optionally resampled, re-encoded as MozJPEG, and its
 * stream replaced only when the result is genuinely smaller. A per-image decode
 * or encode failure becomes an `'error'` outcome and never sinks the whole run;
 * an abort is the one error that propagates.
 */
export async function compressPdf(
  bytes: ArrayBuffer | Uint8Array,
  settings: PdfCompressSettings,
  deps: PdfCompressDeps = {},
): Promise<PdfCompressResult> {
  const start = performance.now();
  const srcBytes = bytes.byteLength;

  const analysis = await analyzePdf(bytes);
  if (analysis.refusal) {
    // Nothing we can safely touch — hand the original back untouched, no bridge.
    return {
      bytes: toArrayBuffer(bytes),
      srcBytes,
      outBytes: srcBytes,
      images: [],
      replaced: 0,
      deduped: 0,
      ms: Math.round(performance.now() - start),
    };
  }

  const owned = deps.bridge ? undefined : createWorkerBridge();
  const bridge = deps.bridge ?? owned!;

  try {
    const signal = deps.signal ?? new AbortController().signal;
    const decode = deps.decodeImageData ?? decodePdfImageData;
    const resample = deps.resampleImageData ?? resampleImageData;

    const doc = await PDFDocument.load(bytes, { updateMetadata: false });

    const outcomes: PdfImageOutcome[] = [];
    let replaced = 0;
    const total = analysis.images.length;

    for (let i = 0; i < total; i += 1) {
      const info = analysis.images[i]!;
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const reason = imageSkipReason(info, settings);
      if (reason) {
        outcomes.push({ ref: info.ref, srcBytes: info.srcBytes, skipped: reason });
        deps.onProgress?.(i + 1, total);
        continue;
      }

      const ref = parseRef(info.ref);
      const stream = ref ? doc.context.lookup(ref) : undefined;
      if (!ref || !(stream instanceof PDFRawStream)) {
        outcomes.push({
          ref: info.ref,
          srcBytes: info.srcBytes,
          skipped: 'error',
          error: 'stream not found',
        });
        deps.onProgress?.(i + 1, total);
        continue;
      }

      try {
        let image = await decode({ bridge, signal }, stream, info);
        const target = resampleTarget(info, settings);
        if (target) image = resample(image, target);

        const encoded = await bridge.encode(signal, 'mozjpeg', image, {
          ...DEFAULT_ENCODER_OPTIONS.mozjpeg,
          quality: settings.imageQuality,
        });

        if (encoded.byteLength < info.srcBytes) {
          replaceImageStream(doc, ref, new Uint8Array(encoded), {
            width: image.width,
            height: image.height,
            colorSpace: info.colorSpace === '/DeviceGray' ? 'DeviceGray' : 'DeviceRGB',
          });

          // `encode` structured-clones its input, so `image` is still live for a
          // round-trip SSIM against the freshly decoded JPEG.
          let ssim: number | null = null;
          if (settings.measure) {
            try {
              const roundTrip = await bridge.decode(signal, 'image/jpeg', encoded.slice(0));
              ssim = measureSsim(image, roundTrip);
            } catch (error) {
              if (isAbortError(error)) throw error;
              ssim = null; // measured but unmeasurable — dimensions changed, etc.
            }
          }

          outcomes.push({
            ref: info.ref,
            srcBytes: info.srcBytes,
            outBytes: encoded.byteLength,
            ...(target ? { resampledTo: target } : {}),
            ...(settings.measure ? { ssim } : {}),
          });
          replaced += 1;
        } else {
          outcomes.push({ ref: info.ref, srcBytes: info.srcBytes, skipped: 'not-smaller' });
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        outcomes.push({
          ref: info.ref,
          srcBytes: info.srcBytes,
          skipped: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }

      deps.onProgress?.(i + 1, total);
    }

    const deduped = settings.dedupeImages ? dedupeImages(doc) : 0;
    if (settings.stripMetadata) stripMetadata(doc);

    const saved = await doc.save({ useObjectStreams: true });
    return {
      bytes: toArrayBuffer(saved),
      srcBytes,
      outBytes: saved.byteLength,
      images: outcomes,
      replaced,
      deduped,
      ms: Math.round(performance.now() - start),
    };
  } finally {
    // Only a bridge we created is ours to tear down; injected ones outlive us.
    owned?.terminate();
  }
}

/** `"12 0 R"` → `PDFRef`, or `undefined` when the string is not a plain ref. */
function parseRef(ref: string): PDFRef | undefined {
  const match = /^(\d+) (\d+) R$/.exec(ref);
  if (!match) return undefined;
  return PDFRef.of(Number(match[1]), Number(match[2]));
}

/**
 * Narrow `ArrayBuffer | Uint8Array` to a plain `ArrayBuffer` without copying when
 * the view already covers its whole backing buffer (the common case for a raw
 * input or a `doc.save()` result).
 */
function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}
