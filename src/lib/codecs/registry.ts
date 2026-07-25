/**
 * The encoder registry: static metadata for every encoder, plus the lazy loader
 * that turns an {@link EncoderId} into a runnable {@link EncoderModule}.
 *
 * ## What is eager and what is not
 * {@link ENCODER_REGISTRY} is plain data — labels, MIME types, extensions — so
 * the UI can populate its `<select>`, name output files and reason about alpha
 * support without touching wasm. It imports nothing.
 *
 * Implementations are behind `import()`:
 * - `browser-*` and `identity` resolve to `./browser-encoders`, a canvas-only
 *   module that never appears in the initial bundle;
 * - the six wasm codecs resolve to `./worker-encoders`, thin wrappers over a
 *   {@link WorkerBridgeApi}. The wasm itself is dynamically imported *inside*
 *   the worker, one codec at a time — see `codec.worker.ts`. Selecting AVIF
 *   therefore never downloads the JXL build.
 *
 * ## Bridges
 * Prefer {@link createEncoderLoader}: the job engine gives each editor side its
 * own worker so aborting one side does not throw away the other side's warm
 * wasm. {@link loadEncoderModule} exists for one-off callers and shares a
 * single process-wide bridge.
 */

import {
  DEFAULT_ENCODER_OPTIONS,
  ENCODER_IDS,
  EXTENSION_BY_MIME,
  isWorkerEncoderId,
  replaceExtension,
  type EncoderId,
  type EncoderMeta,
  type EncoderModule,
  type EncoderRegistry,
  type LoadEncoderModule,
  type OutputMimeType,
  type WorkerBridgeApi,
} from '../contracts';

/* -------------------------------------------------------------------------- */
/* Metadata                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every encoder squish ships, as data.
 *
 * `lossy` describes the codec at its *default* settings — WebP, AVIF and JXL
 * all have a lossless switch, but nobody reaches for them expecting lossless.
 */
export const ENCODER_REGISTRY: EncoderRegistry = {
  identity: {
    id: 'identity',
    label: 'Original',
    mimeType: '',
    extension: '',
    defaultOptions: DEFAULT_ENCODER_OPTIONS.identity,
    lossy: false,
    supportsAlpha: true,
    usesWorker: false,
  },
  mozjpeg: {
    id: 'mozjpeg',
    label: 'MozJPEG',
    mimeType: 'image/jpeg',
    extension: 'jpg',
    defaultOptions: DEFAULT_ENCODER_OPTIONS.mozjpeg,
    lossy: true,
    supportsAlpha: false,
    usesWorker: true,
  },
  oxipng: {
    id: 'oxipng',
    label: 'OxiPNG',
    mimeType: 'image/png',
    extension: 'png',
    defaultOptions: DEFAULT_ENCODER_OPTIONS.oxipng,
    lossy: false,
    supportsAlpha: true,
    usesWorker: true,
  },
  webp: {
    id: 'webp',
    label: 'WebP',
    mimeType: 'image/webp',
    extension: 'webp',
    defaultOptions: DEFAULT_ENCODER_OPTIONS.webp,
    lossy: true,
    supportsAlpha: true,
    usesWorker: true,
  },
  avif: {
    id: 'avif',
    label: 'AVIF',
    mimeType: 'image/avif',
    extension: 'avif',
    defaultOptions: DEFAULT_ENCODER_OPTIONS.avif,
    lossy: true,
    supportsAlpha: true,
    usesWorker: true,
  },
  jxl: {
    id: 'jxl',
    label: 'JPEG XL',
    mimeType: 'image/jxl',
    extension: 'jxl',
    defaultOptions: DEFAULT_ENCODER_OPTIONS.jxl,
    lossy: true,
    supportsAlpha: true,
    usesWorker: true,
  },
  qoi: {
    id: 'qoi',
    label: 'QOI',
    mimeType: 'image/qoi',
    extension: 'qoi',
    defaultOptions: DEFAULT_ENCODER_OPTIONS.qoi,
    lossy: false,
    supportsAlpha: true,
    usesWorker: true,
  },
  'browser-jpeg': {
    id: 'browser-jpeg',
    label: 'Browser JPEG',
    mimeType: 'image/jpeg',
    extension: 'jpg',
    defaultOptions: DEFAULT_ENCODER_OPTIONS['browser-jpeg'],
    lossy: true,
    supportsAlpha: false,
    usesWorker: false,
  },
  'browser-png': {
    id: 'browser-png',
    label: 'Browser PNG',
    mimeType: 'image/png',
    extension: 'png',
    defaultOptions: DEFAULT_ENCODER_OPTIONS['browser-png'],
    lossy: false,
    supportsAlpha: true,
    usesWorker: false,
  },
  'browser-webp': {
    id: 'browser-webp',
    label: 'Browser WebP',
    mimeType: 'image/webp',
    extension: 'webp',
    defaultOptions: DEFAULT_ENCODER_OPTIONS['browser-webp'],
    lossy: true,
    supportsAlpha: true,
    usesWorker: false,
  },
};

/** Registry metas in the `<select>` display order from the contracts. */
export const ENCODER_METAS: readonly EncoderMeta[] = ENCODER_IDS.map(
  (id) => ENCODER_REGISTRY[id] as EncoderMeta,
);

export function getEncoderMeta<K extends EncoderId>(id: K): EncoderMeta<K> {
  return ENCODER_REGISTRY[id];
}

export function encoderLabel(id: EncoderId): string {
  return ENCODER_REGISTRY[id].label;
}

export function encoderMimeType(id: EncoderId): OutputMimeType {
  return ENCODER_REGISTRY[id].mimeType;
}

export function encoderExtension(id: EncoderId): string {
  return ENCODER_REGISTRY[id].extension;
}

/**
 * Name the file an encoder produces.
 *
 * `identity` keeps the source name verbatim — it *is* the source file. Every
 * other encoder swaps the extension, falling back to the extension implied by
 * the encoder's MIME type when a meta somehow has none.
 */
export function outputFileName(sourceName: string, id: EncoderId): string {
  const meta = ENCODER_REGISTRY[id];
  if (id === 'identity' || !meta.mimeType) return sourceName;
  const extension = meta.extension || EXTENSION_BY_MIME[meta.mimeType];
  return replaceExtension(sourceName, extension);
}

/* -------------------------------------------------------------------------- */
/* Lazy implementation loading                                                 */
/* -------------------------------------------------------------------------- */

type AnyEncoderModule = EncoderModule<EncoderId>;

async function loadImplementation(
  id: EncoderId,
  bridge: WorkerBridgeApi,
): Promise<AnyEncoderModule> {
  if (isWorkerEncoderId(id)) {
    const { createWorkerEncoderModule } = await import('./worker-encoders');
    return createWorkerEncoderModule(id, bridge) as AnyEncoderModule;
  }

  const { createBrowserEncoderModule, identityEncoderModule } = await import(
    './browser-encoders'
  );

  if (id === 'identity') return identityEncoderModule as AnyEncoderModule;
  return createBrowserEncoderModule(id) as AnyEncoderModule;
}

/**
 * Build a loader bound to one worker bridge.
 *
 * The returned function memoises per encoder id, so repeated selections of the
 * same codec reuse one module (and therefore one warm wasm instance).
 */
export function createEncoderLoader(bridge: WorkerBridgeApi): LoadEncoderModule {
  const cache = new Map<EncoderId, Promise<AnyEncoderModule>>();

  const load = (id: EncoderId): Promise<AnyEncoderModule> => {
    let pending = cache.get(id);
    if (!pending) {
      pending = loadImplementation(id, bridge).catch((error: unknown) => {
        // Never cache a failure: a transient chunk-load error should not
        // permanently disable an encoder.
        cache.delete(id);
        throw error;
      });
      cache.set(id, pending);
    }
    return pending;
  };

  return load as LoadEncoderModule;
}

let sharedLoader: Promise<LoadEncoderModule> | undefined;

function getSharedLoader(): Promise<LoadEncoderModule> {
  if (!sharedLoader) {
    // Imported lazily so that merely reading encoder metadata never pulls the
    // worker bridge (and its `new Worker(...)` URL) into the caller's graph.
    sharedLoader = import('./bridge').then((mod) =>
      createEncoderLoader(mod.getSharedWorkerBridge()),
    );
  }
  return sharedLoader;
}

/**
 * Loader over a lazily created, process-wide bridge.
 *
 * Convenient for one-off work (a feature test, a single batch item). The editor
 * should use {@link createEncoderLoader} with a per-side bridge instead, so an
 * abort on one side cannot terminate the other side's worker.
 */
export const loadEncoderModule: LoadEncoderModule = ((id: EncoderId) =>
  getSharedLoader().then((load) => load(id))) as LoadEncoderModule;

/** Drop the memoised shared loader. Tests only. */
export function resetSharedEncoderLoader(): void {
  sharedLoader = undefined;
}
