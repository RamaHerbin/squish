/**
 * Job engine tests. No DOM, no wasm: a fake worker bridge and fake platform
 * hooks stand in for the codec layer, which is the whole reason the engine takes
 * both as constructor arguments.
 *
 * `FakeImageData` is a class rather than an object literal on purpose — Svelte's
 * `$state` proxies plain objects but leaves class instances alone, and the
 * result cache matches preprocessed pixels by identity.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultProcessorState,
  createDefaultSideSettings,
  createSideSettings,
  isBusy,
  RESULT_CACHE_SIZE,
} from '../contracts';
import type {
  EncoderOptionsMap,
  ProcessorState,
  ResizeOptions,
  RotateAngle,
  SideSettings,
  WorkerBridgeApi,
  WorkerEncoderId,
  WorkerResizeOptions,
} from '../contracts';
import { LruResultCache } from './result-cache';
import { planWork, type EngineHooks, type SideJob } from './engine';
import { JobSession } from './session.svelte';
import { AppState } from './app.svelte';
import {
  createMemoryStore,
  createSettingsPersistence,
  loadAllSideSettings,
  sanitizeSideSettings,
  saveSideSettings,
} from './settings-persistence';

/* -------------------------------------------------------------------------- */
/* Doubles                                                                     */
/* -------------------------------------------------------------------------- */

class FakeImageData {
  readonly data: Uint8ClampedArray;
  constructor(
    readonly width: number,
    readonly height: number,
    readonly tag = 'src',
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

function image(width = 4, height = 4, tag = 'src'): ImageData {
  return new FakeImageData(width, height, tag) as unknown as ImageData;
}

function file(name = 'photo.png', type = 'image/png', bytes = 64): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

interface FakeBridge extends WorkerBridgeApi {
  calls: { decode: number; encode: number; resize: number; rotate: number; terminate: number };
  encoded: WorkerEncoderId[];
  failEncode?: Error;
  delay: number;
}

function createFakeBridge(): FakeBridge {
  const calls = { decode: 0, encode: 0, resize: 0, rotate: 0, terminate: 0 };
  const encoded: WorkerEncoderId[] = [];

  const wait = async (bridge: FakeBridge) => {
    if (bridge.delay > 0) await new Promise((resolve) => setTimeout(resolve, bridge.delay));
  };

  const bridge: FakeBridge = {
    calls,
    encoded,
    delay: 0,
    async decode() {
      calls.decode++;
      await wait(bridge);
      return image(4, 4, 'decoded');
    },
    async encode<K extends WorkerEncoderId>(
      _signal: AbortSignal,
      id: K,
      _data: ImageData,
      options: EncoderOptionsMap[K],
    ) {
      calls.encode++;
      encoded.push(id);
      await wait(bridge);
      if (bridge.failEncode) throw bridge.failEncode;
      const quality = (options as { quality?: number }).quality ?? 0;
      return new Uint8Array([quality & 0xff, calls.encode & 0xff]).buffer;
    },
    async resize(_signal: AbortSignal, _data: ImageData, options: WorkerResizeOptions) {
      calls.resize++;
      await wait(bridge);
      return image(options.width, options.height, 'resized');
    },
    async rotate(_signal: AbortSignal, data: ImageData, angle: RotateAngle) {
      calls.rotate++;
      await wait(bridge);
      return angle % 180 === 0
        ? image(data.width, data.height, 'rotated')
        : image(data.height, data.width, 'rotated');
    },
    preload() {},
    terminate() {
      calls.terminate++;
    },
  };
  return bridge;
}

interface Harness {
  session: JobSession;
  bridges: FakeBridge[];
  hooks: EngineHooks;
  decodeSourceCalls: number;
  decodeFailure?: Error;
}

function createHarness(
  overrides: Partial<EngineHooks> = {},
  options: { initialSides?: [SideSettings, SideSettings]; debounceMs?: number } = {},
): Harness {
  const bridges: FakeBridge[] = [];
  const harness: Partial<Harness> & { decodeSourceCalls: number } = { decodeSourceCalls: 0 };

  const hooks: EngineHooks = {
    async decodeSource(_signal, sourceFile) {
      harness.decodeSourceCalls++;
      if (harness.decodeFailure) throw harness.decodeFailure;
      return { file: sourceFile, decoded: image(8, 6, 'decoded') };
    },
    async decodeOutput() {
      return image(8, 6, 'roundtrip');
    },
    async encodeBrowser() {
      return new Uint8Array([1, 2, 3]).buffer;
    },
    async resizeOnMainThread(_signal, _data, resizeOptions) {
      return image(resizeOptions.width, resizeOptions.height, 'canvas-resized');
    },
    async crop(_signal, data) {
      return image(data.width, data.height, 'cropped');
    },
    ...overrides,
  };

  const session = new JobSession({
    createBridge: () => {
      const bridge = createFakeBridge();
      bridges.push(bridge);
      return bridge;
    },
    hooks,
    debounceMs: options.debounceMs ?? 0,
    initialSides: options.initialSides,
  });

  harness.session = session;
  harness.bridges = bridges;
  harness.hooks = hooks;
  return harness as Harness;
}

function mozjpeg(quality: number, processorState?: ProcessorState): SideSettings {
  return createSideSettings('mozjpeg', { quality }, processorState);
}

/* -------------------------------------------------------------------------- */
/* planWork                                                                    */
/* -------------------------------------------------------------------------- */

describe('planWork', () => {
  const sourceFile = file();
  const preprocessorState = { rotate: 0 as const };

  const desired = (left: SideSettings, right: SideSettings) => ({
    main: { file: sourceFile, preprocessorState },
    sides: [{ settings: left }, { settings: right }] as [SideJob, SideJob],
  });

  it('asks for nothing when the desired state already produced the result', () => {
    const left = createDefaultSideSettings(0);
    const right = mozjpeg(75);
    const plan = planWork(
      {
        main: { file: sourceFile, preprocessorState },
        sides: [{ settings: left }, { settings: right }],
      },
      desired(left, mozjpeg(75)),
    );
    expect(plan.needed).toBe(false);
  });

  it('re-encodes without re-processing when only encoder options change', () => {
    const left = createDefaultSideSettings(0);
    const plan = planWork(
      {
        main: { file: sourceFile, preprocessorState },
        sides: [{ settings: left }, { settings: mozjpeg(75) }],
      },
      desired(left, mozjpeg(40)),
    );
    expect(plan.sides[1]).toEqual({ processing: false, encoding: true });
    expect(plan.sides[0]).toEqual({ processing: false, encoding: false });
    expect(plan.decoding).toBe(false);
  });

  it('treats two disabled resize configs as equal, stale numbers and all', () => {
    const a: ProcessorState = { resize: { ...createDefaultProcessorState().resize, width: 900 } };
    const b: ProcessorState = { resize: { ...createDefaultProcessorState().resize, width: 32 } };
    const plan = planWork(
      {
        main: { file: sourceFile, preprocessorState },
        sides: [{ settings: mozjpeg(75, a) }, { settings: mozjpeg(75, a) }],
      },
      desired(mozjpeg(75, b), mozjpeg(75, b)),
    );
    expect(plan.needed).toBe(false);
  });

  it('reprocesses both sides when the shared preprocessor changes', () => {
    const left = createDefaultSideSettings(0);
    const right = mozjpeg(75);
    const plan = planWork(
      {
        main: { file: sourceFile, preprocessorState: { rotate: 0 } },
        sides: [{ settings: left }, { settings: right }],
      },
      {
        main: { file: sourceFile, preprocessorState: { rotate: 90 } },
        sides: [{ settings: left }, { settings: right }],
      },
    );
    expect(plan.preprocessing).toBe(true);
    expect(plan.decoding).toBe(false);
    expect(plan.sides[0].processing && plan.sides[1].processing).toBe(true);
  });

  it('decodes when the file changes, which forces everything downstream', () => {
    const left = createDefaultSideSettings(0);
    const plan = planWork(
      { main: { file: sourceFile, preprocessorState }, sides: [undefined, undefined] },
      desired(left, mozjpeg(75)),
    );
    expect(plan.decoding).toBe(false);
    const other = planWork(
      { main: { file: file('other.png'), preprocessorState }, sides: [undefined, undefined] },
      desired(left, mozjpeg(75)),
    );
    expect(other.decoding).toBe(true);
    expect(other.preprocessing).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Result cache                                                                */
/* -------------------------------------------------------------------------- */

describe('LruResultCache', () => {
  const entry = (preprocessed: ImageData, quality: number) => ({
    preprocessed,
    processorState: createDefaultProcessorState(),
    encoderId: 'mozjpeg' as const,
    encoderOptions: { ...mozjpeg(quality).encoderOptions },
    processed: image(),
    data: image(),
    file: file(`q${quality}.jpg`, 'image/jpeg'),
  });

  it('matches on identity of the preprocessed pixels', () => {
    const cache = new LruResultCache();
    const pixels = image();
    cache.add(entry(pixels, 75));

    const hit = cache.match(pixels, createDefaultProcessorState(), 'mozjpeg', {
      ...mozjpeg(75).encoderOptions,
    });
    expect(hit?.file.name).toBe('q75.jpg');

    // Same values, different object: a different image entirely as far as the
    // cache is concerned.
    expect(
      cache.match(image(), createDefaultProcessorState(), 'mozjpeg', {
        ...mozjpeg(75).encoderOptions,
      }),
    ).toBeUndefined();
  });

  it('evicts the least recently used entry beyond the limit', () => {
    const cache = new LruResultCache();
    const pixels = image();
    for (let quality = 1; quality <= RESULT_CACHE_SIZE + 1; quality++) {
      cache.add(entry(pixels, quality));
    }
    expect(cache.entries).toHaveLength(RESULT_CACHE_SIZE);
    expect(
      cache.match(pixels, createDefaultProcessorState(), 'mozjpeg', {
        ...mozjpeg(1).encoderOptions,
      }),
    ).toBeUndefined();
  });

  it('promotes a hit to the front', () => {
    const cache = new LruResultCache();
    const pixels = image();
    cache.add(entry(pixels, 10));
    cache.add(entry(pixels, 20));
    cache.match(pixels, createDefaultProcessorState(), 'mozjpeg', {
      ...mozjpeg(10).encoderOptions,
    });
    expect(cache.entries[0]?.file.name).toBe('q10.jpg');
  });
});

/* -------------------------------------------------------------------------- */
/* Session                                                                     */
/* -------------------------------------------------------------------------- */

describe('JobSession', () => {
  it('decodes once and fills both sides', async () => {
    const { session, bridges } = createHarness();
    const source = file('photo.png');
    session.setSource(source);
    await session.flush();

    expect(session.state.source?.file).toBe(source);
    expect(session.state.loading).toBe(false);
    expect(isBusy(session.state)).toBe(false);

    // Side 0 is the identity pass-through: the original file, untouched.
    expect(session.state.sides[0].file).toBe(source);
    expect(session.state.sides[0].encodedSettings?.encoderId).toBe('identity');

    // Side 1 encoded through the worker, and its result was decoded back.
    expect(session.state.sides[1].file?.name).toBe('photo.jpg');
    expect(session.state.sides[1].file?.type).toBe('image/jpeg');
    expect(session.state.sides[1].encodedSettings?.encoderId).toBe('mozjpeg');
    expect(bridges[1]?.calls.encode).toBe(1);
    // Each side owns a worker; side 0 never touched its own.
    expect(bridges[0]?.calls.encode).toBe(0);
  });

  it('seeds resize dimensions from the decoded image, switched off', async () => {
    const { session } = createHarness();
    session.setSource(file());
    await session.flush();

    for (const side of [0, 1] as const) {
      const resize = session.state.sides[side].latestSettings.processorState.resize;
      expect(resize.width).toBe(8);
      expect(resize.height).toBe(6);
      expect(resize.enabled).toBe(false);
    }
  });

  it('keeps encodedSettings behind latestSettings until the encode lands', async () => {
    const { session, bridges } = createHarness();
    session.setSource(file());
    await session.flush();

    const bridge = bridges[1];
    if (!bridge) throw new Error('missing bridge');
    bridge.delay = 20;

    session.updateSide(1, mozjpeg(30));
    // The UI immediately reflects the request…
    expect(session.state.sides[1].latestSettings.encoderOptions).toMatchObject({ quality: 30 });
    // …but the pixels on screen are still described by the old settings.
    expect(session.state.sides[1].encodedSettings?.encoderOptions).toMatchObject({ quality: 75 });
    expect(session.state.sides[1].loading).toBe(true);

    await session.flush();
    expect(session.state.sides[1].encodedSettings?.encoderOptions).toMatchObject({ quality: 30 });
    expect(session.state.sides[1].loading).toBe(false);
  });

  it('serves a repeated setting from the cache instead of re-encoding', async () => {
    const { session, bridges } = createHarness();
    session.setSource(file());
    await session.flush();
    const bridge = bridges[1];
    if (!bridge) throw new Error('missing bridge');
    expect(bridge.calls.encode).toBe(1);

    session.updateSide(1, mozjpeg(40));
    await session.flush();
    expect(bridge.calls.encode).toBe(2);

    // Back to a value we already encoded: no wasm, instant result.
    session.updateSide(1, mozjpeg(75));
    await session.flush();
    expect(bridge.calls.encode).toBe(2);
    expect(session.state.sides[1].encodedSettings?.encoderOptions).toMatchObject({ quality: 75 });
  });

  it('leaves the other side\u2019s in-flight work alone', async () => {
    const { session, bridges } = createHarness();
    session.setSource(file());
    await session.flush();

    const left = bridges[0];
    const right = bridges[1];
    if (!left || !right) throw new Error('missing bridge');

    session.updateSide(0, mozjpeg(90));
    await session.flush();
    expect(left.calls.encode).toBe(1);
    const rightEncodes = right.calls.encode;

    session.updateSide(1, mozjpeg(20));
    await session.flush();
    expect(left.calls.encode).toBe(1);
    expect(right.calls.encode).toBe(rightEncodes + 1);
  });

  it('runs the resize through the worker when the method is a wasm kernel', async () => {
    const { session, bridges } = createHarness();
    session.setSource(file());
    await session.flush();

    const processorState = createDefaultProcessorState();
    processorState.resize.enabled = true;
    processorState.resize.width = 4;
    processorState.resize.height = 3;
    session.updateProcessor(1, processorState);
    await session.flush();

    expect(bridges[1]?.calls.resize).toBe(1);
    expect(session.state.sides[1].encodedSettings?.processorState.resize.width).toBe(4);
  });

  it('routes browser resize methods to the main thread', async () => {
    const resizeOnMainThread = vi.fn(async (_s: AbortSignal, _d: ImageData, opts: ResizeOptions) =>
      image(opts.width, opts.height, 'canvas'),
    );
    const { session, bridges } = createHarness({ resizeOnMainThread });
    session.setSource(file());
    await session.flush();

    const processorState = createDefaultProcessorState();
    processorState.resize.enabled = true;
    processorState.resize.width = 5;
    processorState.resize.height = 5;
    processorState.resize.method = 'browser-high';
    session.updateProcessor(1, processorState);
    await session.flush();

    expect(resizeOnMainThread).toHaveBeenCalledTimes(1);
    expect(bridges[1]?.calls.resize).toBe(0);
  });

  it('rotating swaps each side\u2019s target dimensions and reprocesses both sides', async () => {
    const { session, bridges } = createHarness();
    session.setSource(file());
    await session.flush();
    const encodesBefore = bridges[1]?.calls.encode ?? 0;

    session.updatePreprocessor({ rotate: 90 });
    await session.flush();

    const resize = session.state.sides[1].latestSettings.processorState.resize;
    expect(resize.width).toBe(6);
    expect(resize.height).toBe(8);
    expect(bridges[0]?.calls.rotate).toBe(1);
    expect(bridges[1]?.calls.encode).toBe(encodesBefore + 1);
    expect(session.state.encodedPreprocessorState).toEqual({ rotate: 90 });
  });

  it('reports a source failure once, on the source, not on both sides', async () => {
    const harness = createHarness();
    harness.decodeFailure = new Error('not an image');
    harness.session.setSource(file('broken.png'));
    await harness.session.flush();

    expect(harness.session.state.error).toBe('not an image');
    expect(harness.session.state.source).toBeUndefined();
    expect(harness.session.state.loading).toBe(false);
    expect(harness.session.state.sides[0].error).toBeUndefined();
    expect(harness.session.state.sides[1].error).toBeUndefined();
    expect(harness.session.state.sides[1].loading).toBe(false);
  });

  it('surfaces an encoder failure on its own side only', async () => {
    const { session, bridges } = createHarness();
    session.setSource(file());
    await session.flush();

    const bridge = bridges[1];
    if (!bridge) throw new Error('missing bridge');
    bridge.failEncode = new Error('wasm exploded');

    session.updateSide(1, mozjpeg(10));
    await session.flush();

    expect(session.state.sides[1].error).toBe('wasm exploded');
    expect(session.state.sides[1].loading).toBe(false);
    expect(session.state.error).toBeUndefined();
    expect(session.state.sides[0].error).toBeUndefined();
    // The last good result is still on screen, still correctly described.
    expect(session.state.sides[1].encodedSettings?.encoderOptions).toMatchObject({ quality: 75 });
  });

  it('drops the result of an abandoned encode', async () => {
    const { session, bridges } = createHarness();
    session.setSource(file());
    await session.flush();

    const bridge = bridges[1];
    if (!bridge) throw new Error('missing bridge');
    bridge.delay = 30;

    session.updateSide(1, mozjpeg(11));
    session.updateSide(1, mozjpeg(22));
    await session.flush();

    expect(session.state.sides[1].encodedSettings?.encoderOptions).toMatchObject({ quality: 22 });
    expect(session.state.sides[1].loading).toBe(false);
  });

  it('revokes the previous object URL when a side is replaced', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const { session } = createHarness();
    session.setSource(file());
    await session.flush();

    const first = session.state.sides[1].downloadUrl;
    expect(typeof first).toBe('string');

    session.updateSide(1, mozjpeg(35));
    await session.flush();

    expect(session.state.sides[1].downloadUrl).not.toBe(first);
    expect(revoke).toHaveBeenCalledWith(first);
    revoke.mockRestore();
  });

  it('mints a fresh URL when copying settings across', async () => {
    const { session } = createHarness();
    session.setSource(file());
    await session.flush();

    const rightUrl = session.state.sides[1].downloadUrl;
    session.copySettings(1);

    expect(session.state.sides[0].latestSettings.encoderId).toBe('mozjpeg');
    expect(session.state.sides[0].file).toBe(session.state.sides[1].file);
    // Same bytes, different URL: revoking one must not break the other.
    expect(session.state.sides[0].downloadUrl).not.toBe(rightUrl);
    expect(typeof session.state.sides[0].downloadUrl).toBe('string');

    await session.flush();
    expect(session.state.sides[0].encodedSettings?.encoderId).toBe('mozjpeg');
  });

  it('emits the lifecycle events a UI needs', async () => {
    const events: string[] = [];
    const { session } = createHarness();
    session.subscribe((event) => events.push(event.type));
    session.setSource(file());
    await session.flush();

    expect(events).toContain('source-loading');
    expect(events).toContain('source-decoded');
    expect(events).toContain('side-start');
    expect(events).toContain('side-encoded');
    expect(events).toContain('idle');
  });

  it('abort stops work without throwing away results', async () => {
    const { session, bridges } = createHarness();
    session.setSource(file());
    await session.flush();
    const encoded = session.state.sides[1].file;

    const bridge = bridges[1];
    if (!bridge) throw new Error('missing bridge');
    bridge.delay = 50;
    session.updateSide(1, mozjpeg(5));
    session.abort();
    await session.flush();

    expect(session.state.sides[1].file).toBe(encoded);
    expect(session.state.sides[1].loading).toBe(false);
  });

  it('dispose terminates every worker and revokes every URL', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const { session, bridges } = createHarness();
    session.setSource(file());
    await session.flush();
    const url = session.state.sides[1].downloadUrl;

    session.dispose();
    expect(bridges[0]?.calls.terminate).toBe(1);
    expect(bridges[1]?.calls.terminate).toBe(1);
    expect(revoke).toHaveBeenCalledWith(url);

    // Inert afterwards.
    session.setSource(file('after.png'));
    await session.flush();
    expect(session.state.source?.file.name).toBe('photo.png');
    revoke.mockRestore();
  });

  it('starts from restored settings', async () => {
    const { session, bridges } = createHarness({}, {
      initialSides: [createSideSettings('identity'), createSideSettings('webp', { quality: 60 })],
    });
    session.setSource(file());
    await session.flush();

    expect(bridges[1]?.encoded).toEqual(['webp']);
    expect(session.state.sides[1].file?.name).toBe('photo.webp');
  });
});

/* -------------------------------------------------------------------------- */
/* App shell state                                                             */
/* -------------------------------------------------------------------------- */

describe('AppState', () => {
  it('routes one file to the editor and several to the batch view', () => {
    const app = new AppState();
    app.configure({ createBridge: () => createFakeBridge(), hooks: createHarness().hooks });

    expect(app.mode).toBe('intro');
    app.openFiles([file('a.png')]);
    expect(app.mode).toBe('editor');
    expect(app.session?.state.sides).toHaveLength(2);

    app.openFiles([file('a.png'), file('b.png')]);
    expect(app.mode).toBe('batch');
    expect(app.batchFiles).toHaveLength(2);

    app.reset();
    expect(app.mode).toBe('intro');
    expect(app.session).toBeUndefined();
  });

  it('refuses to open anything before the bridge factory is injected', () => {
    const app = new AppState();
    expect(() => app.openFile(file())).toThrow(/configure/);
  });
});

/* -------------------------------------------------------------------------- */
/* Settings persistence                                                        */
/* -------------------------------------------------------------------------- */

describe('settings persistence', () => {
  it('round-trips settings through a store', async () => {
    const store = createMemoryStore();
    await saveSideSettings(1, mozjpeg(42), store);
    const [left, right] = await loadAllSideSettings(store);

    expect(left.encoderId).toBe('identity');
    expect(right.encoderId).toBe('mozjpeg');
    expect(right.encoderOptions).toMatchObject({ quality: 42 });
  });

  it('rebuilds untrusted records from defaults, dropping junk', () => {
    const sanitized = sanitizeSideSettings({
      encoderId: 'mozjpeg',
      encoderOptions: { quality: 30, __proto__polluted: true, baseline: 'yes' },
      processorState: { resize: { enabled: true, width: 100.6, height: -5, method: 'evil' } },
    });

    expect(sanitized?.encoderId).toBe('mozjpeg');
    expect(sanitized?.encoderOptions).toMatchObject({ quality: 30, baseline: false });
    expect(Object.keys(sanitized?.encoderOptions ?? {})).not.toContain('__proto__polluted');
    expect(sanitized?.processorState.resize.width).toBe(101);
    expect(sanitized?.processorState.resize.height).toBe(1);
    // 'evil' is not a resize method; the default survives.
    expect(sanitized?.processorState.resize.method).toBe('lanczos3');
  });

  it('rejects records that are not settings at all', () => {
    expect(sanitizeSideSettings(null)).toBeUndefined();
    expect(sanitizeSideSettings({ encoderId: 'jpeg2000' })).toBeUndefined();
    expect(sanitizeSideSettings({ encoderId: 'mozjpeg', encoderOptions: {} })).toBeUndefined();
  });

  it('debounces writes and flushes on demand', async () => {
    const store = createMemoryStore();
    const persistence = createSettingsPersistence({ store, debounceMs: 5 });

    persistence.save(1, mozjpeg(10));
    persistence.save(1, mozjpeg(20));
    persistence.save(1, mozjpeg(30));
    await persistence.flush();

    const [, right] = await persistence.load();
    expect(right.encoderOptions).toMatchObject({ quality: 30 });
    persistence.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* Debounce, events, source replacement                                        */
/* -------------------------------------------------------------------------- */

describe('JobSession — scheduling and events', () => {
  it('coalesces a slider drag into a single encode', async () => {
    const harness = createHarness({}, { debounceMs: 15 });
    harness.session.setSource(file());
    await harness.session.flush();
    const before = harness.bridges[1]?.calls.encode ?? 0;

    // Five values in one gesture. Without the trailing debounce this is five
    // wasm encodes, which is what used to run iOS Safari out of memory.
    for (const quality of [70, 65, 60, 55, 50]) harness.session.updateSide(1, mozjpeg(quality));
    await harness.session.flush();

    expect(harness.bridges[1]?.calls.encode).toBe(before + 1);
    expect(harness.session.state.sides[1].encodedSettings?.encoderOptions).toMatchObject({
      quality: 50,
    });
    harness.session.dispose();
  });

  it('switching encoder renames the output and keeps the resize panel', async () => {
    const harness = createHarness();
    harness.session.setSource(file());
    await harness.session.flush();

    const { processorState } = harness.session.state.sides[1].latestSettings;
    harness.session.updateSide(1, createSideSettings('webp', undefined, processorState));
    await harness.session.flush();

    expect(harness.bridges[1]?.encoded.at(-1)).toBe('webp');
    expect(harness.session.state.sides[1].file?.name).toBe('photo.webp');
    expect(harness.session.state.sides[1].file?.type).toBe('image/webp');
    // The seeded dimensions survive the encoder swap.
    expect(harness.session.state.sides[1].latestSettings.processorState.resize.width).toBe(8);
    harness.session.dispose();
  });

  it('replacing the source clears the previous results', async () => {
    const harness = createHarness();
    harness.session.setSource(file('one.png'));
    await harness.session.flush();
    const first = harness.session.state.sides[1].file;

    harness.session.setSource(file('two.png'));
    await harness.session.flush();

    expect(harness.session.state.source?.file.name).toBe('two.png');
    expect(harness.session.state.sides[1].file).not.toBe(first);
    expect(harness.session.state.sides[1].file?.name).toBe('two.jpg');
    // Side 0 is the pass-through: the new original, untouched.
    expect(harness.session.state.sides[0].file?.name).toBe('two.png');
    expect(isBusy(harness.session.state)).toBe(false);
    harness.session.dispose();
  });

  it('stops delivering to an unsubscribed listener', async () => {
    const harness = createHarness();
    const seen: string[] = [];
    const unsubscribe = harness.session.subscribe((event) => seen.push(event.type));

    harness.session.setSource(file());
    await harness.session.flush();
    const delivered = seen.length;
    expect(delivered).toBeGreaterThan(0);

    unsubscribe();
    harness.session.updateSide(1, mozjpeg(33));
    await harness.session.flush();

    expect(seen).toHaveLength(delivered);
    harness.session.dispose();
  });

  it('survives a subscriber that throws', async () => {
    const harness = createHarness();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    harness.session.subscribe(() => {
      throw new Error('bad listener');
    });

    harness.session.setSource(file());
    await harness.session.flush();

    // A broken subscriber must not take the encode down with it.
    expect(harness.session.state.sides[1].file).toBeDefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    harness.session.dispose();
  });

  it('ignores work after dispose', async () => {
    const harness = createHarness();
    harness.session.setSource(file());
    await harness.session.flush();
    harness.session.dispose();

    const before = harness.bridges[1]?.calls.encode ?? 0;
    harness.session.updateSide(1, mozjpeg(1));
    await harness.session.flush();

    expect(harness.bridges[1]?.calls.encode).toBe(before);
  });
});
