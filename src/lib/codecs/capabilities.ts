/**
 * Runtime capability detection.
 *
 * Everything here is memoised: the probes are cheap but they are asked for on
 * every encoder `<select>` render, so the answer is computed once per realm.
 *
 * The module is safe to import from the main thread, a worker, or a Node test —
 * every DOM/worker global is touched behind a `typeof` guard and only inside a
 * function body, never at module scope.
 */

import type { ImageMimeType } from '../contracts';

/* -------------------------------------------------------------------------- */
/* Environment shape                                                           */
/* -------------------------------------------------------------------------- */

/** True in a `Window` realm (a `document` exists). */
export function hasDocument(): boolean {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

/** True inside a `WorkerGlobalScope`. Works for module workers (no `importScripts`). */
export function isWorkerScope(): boolean {
  return typeof WorkerGlobalScope !== 'undefined' && !hasDocument();
}

/**
 * True when this realm can spawn a `Worker`.
 *
 * On the main thread this is "does the browser have workers at all". Inside a
 * worker it answers "are *nested* workers supported" — Safari 16.0–16.3 shipped
 * wasm threads without nested worker support, which is exactly the combination
 * that breaks pthread-based codecs called from a worker.
 */
export function supportsNestedWorkers(): boolean {
  return typeof Worker !== 'undefined';
}

export function hasOffscreenCanvas(): boolean {
  return typeof OffscreenCanvas !== 'undefined';
}

export function hasCreateImageBitmap(): boolean {
  return typeof createImageBitmap === 'function';
}

/** WebCodecs `ImageDecoder` — the fastest built-in decode path when present. */
export function hasImageDecoder(): boolean {
  return typeof ImageDecoder !== 'undefined';
}

/** `SharedArrayBuffer` is only usable in a cross-origin-isolated context. */
export function isCrossOriginIsolated(): boolean {
  return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true;
}

/** WebKit-family engine sniff (Safari only, not Chrome/Edge on macOS). */
export function isSafari(): boolean {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return /Safari\//.test(ua) && !/Chrom(e|ium)\//.test(ua);
}

/* -------------------------------------------------------------------------- */
/* wasm feature probes                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Minimal wasm modules exercising one proposal each. Byte sequences ported from
 * `wasm-feature-detect` (Apache-2.0) so this module carries no dependency —
 * important, because it is imported by the worker where every byte is on the
 * critical path.
 */
const SIMD_PROBE = Uint8Array.of(
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0,
  253, 15, 253, 98, 11,
);

const THREADS_PROBE = Uint8Array.of(
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1, 1, 10, 11, 1,
  9, 0, 65, 0, 254, 16, 2, 0, 26, 11,
);

let simdPromise: Promise<boolean> | undefined;
let threadsPromise: Promise<boolean> | undefined;

/** Fixed-width SIMD (`v128`). Picks the `*_simd` webp/jxl builds inside jSquash. */
export function supportsWasmSimd(): Promise<boolean> {
  if (!simdPromise) {
    simdPromise = (async () => {
      try {
        return WebAssembly.validate(SIMD_PROBE);
      } catch {
        return false;
      }
    })();
  }
  return simdPromise;
}

/** Raw threads probe: shared memory + atomics, without the nested-worker caveat. */
async function detectWasmThreads(): Promise<boolean> {
  try {
    if (typeof SharedArrayBuffer === 'undefined') return false;
    // Chrome only enables SharedArrayBuffer *transfer* under cross-origin
    // isolation, and pthreads need to hand the memory to their workers.
    if (typeof MessageChannel !== 'undefined') {
      new MessageChannel().port1.postMessage(new SharedArrayBuffer(1));
    }
    return WebAssembly.validate(THREADS_PROBE);
  } catch {
    return false;
  }
}

/**
 * Threads *as squish can actually use them*: shared memory, atomics, and —
 * when asked from inside a worker — the ability to spawn the nested workers
 * emscripten's pthread pool needs.
 */
export function supportsWasmThreads(): Promise<boolean> {
  if (!threadsPromise) {
    threadsPromise = (async () => {
      if (!(await detectWasmThreads())) return false;
      if (isWorkerScope() && !supportsNestedWorkers()) return false;
      return true;
    })();
  }
  return threadsPromise;
}


/**
 * Neutralise threaded wasm in this realm when the nested workers it needs
 * cannot be spawned.
 *
 * Two situations need this, and they are found out in opposite ways:
 *
 * 1. **Safari 16.0–16.3** reports wasm threads support but has no nested
 *    workers at all. `supportsNestedWorkers()` sees that directly, so the
 *    default (unforced) call handles it.
 * 2. **The nested worker script is refused or missing.** A cross-origin-isolated
 *    page will not instantiate a worker whose *script response* lacks a matching
 *    `Cross-Origin-Embedder-Policy` header, and a long-lived `immutable` HTTP
 *    cache keeps serving a returning visitor the copy it fetched before that
 *    header existed. A 404'd chunk fails the same way. `Worker` exists and works
 *    fine in those browsers, so no probe here can see it coming — the bridge
 *    finds out by watching a worker die and respawns it with `force`.
 *
 * jSquash decides between the single- and multi-threaded builds internally, by
 * calling `wasm-feature-detect`'s `threads()`, which only looks at
 * `SharedArrayBuffer`. There is no option to override that choice — so the one
 * lever available is to remove `SharedArrayBuffer` from the worker's global
 * scope before any codec initialises, which makes that probe report `false` and
 * selects the single-threaded build.
 *
 * Call once at worker startup. No-op everywhere the combination is sane.
 *
 * @param force apply even when nested workers look supported — case 2, where
 *   the only evidence is a worker that already died.
 * @returns true when the workaround was applied.
 */
export function applyNestedWorkerWorkaround(force = false): boolean {
  if (!isWorkerScope()) return false;
  if (!force && supportsNestedWorkers()) return false;
  if (typeof SharedArrayBuffer === 'undefined') return false;
  try {
    return Reflect.deleteProperty(globalThis, 'SharedArrayBuffer');
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Per-MIME decode support                                                     */
/* -------------------------------------------------------------------------- */

const decodeCache = new Map<string, Promise<boolean>>();

/**
 * Can the browser decode `mimeType` on its own?
 *
 * On the main thread this uses the `<picture>`/`<source type>` trick: the
 * browser only populates `img.currentSrc` from a `<source>` whose `type` it
 * understands, and it does so without a network request. It is the only probe
 * that is both synchronous-ish and honest about AVIF/JXL.
 *
 * Inside a worker there is no DOM, so it falls back to
 * `ImageDecoder.isTypeSupported`.
 */
export function canDecodeImageType(mimeType: string): Promise<boolean> {
  if (!mimeType) return Promise.resolve(false);

  const cached = decodeCache.get(mimeType);
  if (cached) return cached;

  const probe = (async (): Promise<boolean> => {
    if (hasDocument()) {
      const picture = document.createElement('picture');
      const img = document.createElement('img');
      const source = document.createElement('source');
      source.srcset = 'data:,x';
      source.type = mimeType;
      picture.append(source, img);
      // One microtask is all `img.currentSrc` needs to settle.
      await 0;
      return Boolean(img.currentSrc);
    }

    if (hasImageDecoder()) {
      try {
        return await ImageDecoder.isTypeSupported(mimeType);
      } catch {
        return false;
      }
    }

    return false;
  })();

  decodeCache.set(mimeType, probe);
  return probe;
}

/* -------------------------------------------------------------------------- */
/* Per-MIME encode support                                                     */
/* -------------------------------------------------------------------------- */

const encodeCache = new Map<string, Promise<boolean>>();

/**
 * Can `canvas.toBlob` / `convertToBlob` produce `mimeType`?
 *
 * Encodes a 1×1 image and checks the *returned* blob's type, because Safari and
 * Firefox silently fall back to PNG instead of returning `null` for a format
 * they cannot write.
 */
export function canEncodeImageType(mimeType: string): Promise<boolean> {
  if (!mimeType) return Promise.resolve(false);

  const cached = encodeCache.get(mimeType);
  if (cached) return cached;

  const probe = (async (): Promise<boolean> => {
    try {
      const { canvasEncode } = await import('./canvas');
      const blob = await canvasEncode(new ImageData(1, 1), mimeType);
      return blob.type === mimeType;
    } catch {
      return false;
    }
  })();

  encodeCache.set(mimeType, probe);
  return probe;
}

/* -------------------------------------------------------------------------- */
/* Aggregate report                                                            */
/* -------------------------------------------------------------------------- */

/** Mime types worth reporting native decode support for. */
const REPORTED_DECODE_TYPES: readonly ImageMimeType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/jxl',
  'image/gif',
  'image/bmp',
  'image/svg+xml',
];

const REPORTED_ENCODE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export interface CapabilityReport {
  wasmSimd: boolean;
  wasmThreads: boolean;
  nestedWorkers: boolean;
  crossOriginIsolated: boolean;
  imageDecoder: boolean;
  createImageBitmap: boolean;
  offscreenCanvas: boolean;
  safari: boolean;
  /** Native (non-wasm) decode support, keyed by MIME type. */
  decodesNatively: Partial<Record<ImageMimeType, boolean>>;
  /** `canvas.toBlob` support, keyed by MIME type. */
  encodesNatively: Record<(typeof REPORTED_ENCODE_TYPES)[number], boolean>;
}

let reportPromise: Promise<CapabilityReport> | undefined;

/** One-shot snapshot of everything above. Memoised; safe to await repeatedly. */
export function getCapabilities(): Promise<CapabilityReport> {
  if (!reportPromise) {
    reportPromise = (async () => {
      const [simd, threads, decodeFlags, encodeFlags] = await Promise.all([
        supportsWasmSimd(),
        supportsWasmThreads(),
        Promise.all(REPORTED_DECODE_TYPES.map((type) => canDecodeImageType(type))),
        Promise.all(REPORTED_ENCODE_TYPES.map((type) => canEncodeImageType(type))),
      ]);

      const decodesNatively: Partial<Record<ImageMimeType, boolean>> = {};
      REPORTED_DECODE_TYPES.forEach((type, index) => {
        decodesNatively[type] = decodeFlags[index] ?? false;
      });

      return {
        wasmSimd: simd,
        wasmThreads: threads,
        nestedWorkers: supportsNestedWorkers(),
        crossOriginIsolated: isCrossOriginIsolated(),
        imageDecoder: hasImageDecoder(),
        createImageBitmap: hasCreateImageBitmap(),
        offscreenCanvas: hasOffscreenCanvas(),
        safari: isSafari(),
        decodesNatively,
        encodesNatively: {
          'image/png': encodeFlags[0] ?? false,
          'image/jpeg': encodeFlags[1] ?? false,
          'image/webp': encodeFlags[2] ?? false,
        },
      } satisfies CapabilityReport;
    })();
  }
  return reportPromise;
}

/** Drop every memoised probe. Tests only. */
export function resetCapabilityCaches(): void {
  simdPromise = undefined;
  threadsPromise = undefined;
  reportPromise = undefined;
  decodeCache.clear();
  encodeCache.clear();
}
