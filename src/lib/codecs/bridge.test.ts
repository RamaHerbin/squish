// @vitest-environment jsdom
//
// jsdom rather than the default node environment for one reason: every failure
// this file is about arrives as a DOM `Event`, and Node 24 has no `ErrorEvent`
// constructor. A hand-rolled `{ type, message, filename }` bag would only prove
// that `describeWorkerFailure` can read a hand-rolled bag — the production bug
// was a *real* `ErrorEvent` with empty fields, so the fakes here dispatch the
// real constructors.

import * as Comlink from 'comlink';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultOptionsFor,
  WorkerLoadError,
  WorkerTimeoutError,
  type WorkerApi,
} from '../contracts';
import { createWorkerBridge } from './bridge';

/* -------------------------------------------------------------------------- */
/* Fake worker                                                                 */
/* -------------------------------------------------------------------------- */

/** A macrotask turn: drains every microtask the bridge is waiting on. */
const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Byte length of the fake encoder's output, so a resolve is identifiable. */
const ENCODED_BYTES = 8;

/**
 * The slice of the worker API these tests exercise.
 *
 * Only `encode`: it is the one call whose result crosses back as a plain
 * `ArrayBuffer`. Everything else returns through `fromTransferable`, which
 * constructs an `ImageData` — and jsdom has no `ImageData` constructor.
 */
const codecApi: Pick<WorkerApi, 'encode'> = {
  encode: () => Promise.resolve(new ArrayBuffer(ENCODED_BYTES)),
};

/** What a spawned fake does when the bridge talks to it. */
type Behaviour =
  /** Loads, answers `encode`. */
  | { readonly kind: 'serve' }
  /** Emits `event()` instead of ever answering — a script the browser refused. */
  | { readonly kind: 'refuse'; readonly event: () => Event }
  /** Loads and then says nothing: the wedge the watchdog exists for. */
  | { readonly kind: 'wedge' };

const serves: Behaviour = { kind: 'serve' };
const wedges: Behaviour = { kind: 'wedge' };
const refuses = (event: () => Event): Behaviour => ({ kind: 'refuse', event });

/**
 * The worker end of the pipe.
 *
 * Comlink asks four things of an endpoint — `postMessage`, `addEventListener`,
 * `removeEventListener` and an optional `start` — and `EventTarget` already
 * supplies three of them. Nothing is structured-cloned on the way through:
 * these tests care which call was made, not whether a buffer detached.
 */
class WorkerSideEndpoint extends EventTarget {
  constructor(private readonly deliver: (data: unknown) => void) {
    super();
  }

  postMessage(data: unknown): void {
    this.deliver(data);
  }
}

/**
 * A stand-in for the codec worker, driven by one {@link Behaviour}.
 *
 * The refusal is emitted on the *first message*, not at construction, because
 * that is the production sequence: the worker script itself loads fine, and the
 * nested pthread worker is only spawned when an encode triggers the codec's
 * dynamic import. Emitting it at construction would fire before `attempt` has
 * registered the call as in-flight, which no browser does.
 */
class FakeCodecWorker extends EventTarget {
  terminated = 0;
  /** Every message Comlink posted in here, so a retry is provable. */
  readonly received: unknown[] = [];

  private readonly endpoint: WorkerSideEndpoint;

  constructor(
    readonly nothreads: boolean,
    private readonly behaviour: Behaviour,
  ) {
    super();
    this.endpoint = new WorkerSideEndpoint((data) => {
      if (!this.terminated) this.dispatchEvent(new MessageEvent('message', { data }));
    });
    if (behaviour.kind === 'serve') Comlink.expose(codecApi, this.endpoint);
  }

  postMessage(data: unknown): void {
    if (this.terminated) return;
    this.received.push(data);
    // A real worker never answers in the caller's own tick.
    queueMicrotask(() => {
      if (this.terminated) return;
      if (this.behaviour.kind === 'refuse') {
        this.dispatchEvent(this.behaviour.event());
        return;
      }
      this.endpoint.dispatchEvent(new MessageEvent('message', { data }));
    });
  }

  terminate(): void {
    this.terminated++;
  }

  /** jsdom has no `Worker`; the bridge only ever touches the members above. */
  asWorker(): Worker {
    return this as unknown as Worker;
  }
}

/**
 * A `createWorker` seam handing out one fake per spawn, following `script`.
 * The last entry repeats, so a script reads "these, then this from now on".
 */
function workerFactory(...script: readonly Behaviour[]) {
  const spawned: FakeCodecWorker[] = [];

  const createWorker = (nothreads: boolean): Worker => {
    const behaviour = script[Math.min(spawned.length, script.length - 1)] ?? serves;
    const worker = new FakeCodecWorker(nothreads, behaviour);
    spawned.push(worker);
    return worker.asWorker();
  };

  return { createWorker, spawned };
}

/* -------------------------------------------------------------------------- */
/* Failure events, as the browser delivers them                                */
/* -------------------------------------------------------------------------- */

/** Chrome refusing the script response outright: no message, no filename. */
const bareRefusal = () => new Event('error');

/**
 * The production failure: emscripten's pthread bootstrap rethrows the raw
 * `Event` from a refused nested worker, which flattens into this on the way to
 * the main thread. Fields copied from a live pinch.rama.app failure.
 */
const rethrownRefusal = () =>
  new ErrorEvent('error', {
    message: 'Uncaught [object Event]',
    filename: '/assets/avif_enc_mt-lg5nTxsh.js',
    lineno: 1,
    colno: 7522,
  });

/** An `ErrorEvent` that names the script but carries no message. */
const silentRefusal = () =>
  new ErrorEvent('error', {
    filename: '/assets/jxl_enc_mt_simd-D7esk0h_.js',
    lineno: 1,
    colno: 9075,
  });

/* -------------------------------------------------------------------------- */
/* Call helpers                                                                */
/* -------------------------------------------------------------------------- */

/** 1×1: the bridge only reads the dimensions, to size the watchdog budget. */
function image(): ImageData {
  return { data: new Uint8ClampedArray(4), width: 1, height: 1, colorSpace: 'srgb' };
}

/** Timers off by default — each test arms the one behaviour it is about. */
const inert = { idleTimeoutMs: Infinity, watchdogMs: Infinity } as const;

/**
 * Fail any test that drops a rejection on the floor.
 *
 * This is the property no `await` can express, and the bridge has two places
 * that risk it: the watchdog rejects the caller and *then* terminates, which
 * rejects the same in-flight call a second time with an `AbortError`; and the
 * serialisation queue re-uses each call's promise. Both are only safe because a
 * handler is already attached — if one ever is not, users get a spurious
 * unhandled rejection on every timeout.
 */
const unhandled: unknown[] = [];
const collectUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', collectUnhandled);
});

afterEach(async () => {
  // Node reports at the end of a turn; give the late rejections somewhere to land.
  await sleep();
  await sleep();
  process.off('unhandledRejection', collectUnhandled);
  expect(unhandled).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/* Load failure diagnostics                                                    */
/* -------------------------------------------------------------------------- */

describe('worker load failure', () => {
  it('names the likely causes when the event carries nothing at all', async () => {
    const { createWorker, spawned } = workerFactory(refuses(bareRefusal));
    const bridge = createWorkerBridge({ createWorker, ...inert });

    const call = bridge.decode(new AbortController().signal, 'image/avif', new ArrayBuffer(4));

    await expect(call).rejects.toBeInstanceOf(WorkerLoadError);
    await expect(call).rejects.toThrow(
      'The codec worker failed to load (the browser refused the worker script without ' +
        'saying why — usually a cached copy predating COOP/COEP, or a missing chunk). ' +
        'Reload the page and try again.',
    );
    // `decode` transfers its buffer away on attempt 1, so it is the one call the
    // bridge must not re-run: one spawn, then the error.
    expect(spawned.length).toBe(1);
    expect(spawned[0]?.terminated).toBe(1);
  });

  it('quotes the message and the position of a real ErrorEvent', async () => {
    const { createWorker } = workerFactory(refuses(rethrownRefusal));
    const bridge = createWorkerBridge({ createWorker, ...inert });

    await expect(
      bridge.decode(new AbortController().signal, 'image/avif', new ArrayBuffer(4)),
    ).rejects.toThrow(
      'The codec worker failed to load (Uncaught [object Event] in ' +
        '/assets/avif_enc_mt-lg5nTxsh.js:1:7522). Reload the page and try again.',
    );
  });

  it('still names the script when the browser supplies no message', async () => {
    const { createWorker } = workerFactory(refuses(silentRefusal));
    const bridge = createWorkerBridge({ createWorker, ...inert });

    await expect(
      bridge.decode(new AbortController().signal, 'image/jxl', new ArrayBuffer(4)),
    ).rejects.toThrow(
      'The codec worker failed to load (no error detail in ' +
        '/assets/jxl_enc_mt_simd-D7esk0h_.js:1:9075). Reload the page and try again.',
    );
  });

  it('distinguishes a message that could not be deserialised', async () => {
    const { createWorker } = workerFactory(refuses(() => new Event('messageerror')));
    const bridge = createWorkerBridge({ createWorker, ...inert });

    await expect(
      bridge.decode(new AbortController().signal, 'image/png', new ArrayBuffer(4)),
    ).rejects.toThrow(/a worker message could not be deserialised/);
  });
});

/* -------------------------------------------------------------------------- */
/* Single-threaded recovery                                                    */
/* -------------------------------------------------------------------------- */

describe('single-threaded retry', () => {
  it('respawns with the nothreads flag and resolves, silently', async () => {
    const { createWorker, spawned } = workerFactory(refuses(rethrownRefusal), serves);
    const bridge = createWorkerBridge({ createWorker, ...inert });

    const result = await bridge.encode(
      new AbortController().signal,
      'webp',
      image(),
      defaultOptionsFor('webp'),
    );

    expect(result.byteLength).toBe(ENCODED_BYTES);
    expect(spawned.map((worker) => worker.nothreads)).toEqual([false, true]);
    // The call really was re-issued, rather than the first worker answering late.
    expect(spawned[0]?.received.length).toBe(1);
    expect(spawned[1]?.received.length).toBe(1);
    expect(spawned[0]?.terminated).toBe(1);
    expect(spawned[1]?.terminated).toBe(0);
  });

  it('gives up after the single-threaded worker fails too', async () => {
    const { createWorker, spawned } = workerFactory(refuses(bareRefusal), refuses(bareRefusal));
    const bridge = createWorkerBridge({ createWorker, ...inert });

    await expect(
      bridge.encode(new AbortController().signal, 'webp', image(), defaultOptionsFor('webp')),
    ).rejects.toBeInstanceOf(WorkerLoadError);

    // Two attempts, not an infinite respawn loop.
    expect(spawned.length).toBe(2);
    expect(spawned.map((worker) => worker.nothreads)).toEqual([false, true]);
  });

  it('keeps the latch, and the queue, alive for later calls', async () => {
    const { createWorker, spawned } = workerFactory(
      refuses(bareRefusal),
      refuses(bareRefusal),
      serves,
    );
    const bridge = createWorkerBridge({ createWorker, ...inert });
    const signal = new AbortController().signal;
    const options = defaultOptionsFor('webp');

    await expect(
      bridge.encode(signal, 'webp', image(), options),
    ).rejects.toBeInstanceOf(WorkerLoadError);

    // A failed call must not wedge the serialisation queue behind it, and the
    // latch is permanent: a document that refused a nested worker once will not
    // start allowing them later in its life.
    const result = await bridge.encode(signal, 'webp', image(), options);
    expect(result.byteLength).toBe(ENCODED_BYTES);
    expect(spawned.length).toBe(3);
    expect(spawned[2]?.nothreads).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Timers                                                                      */
/* -------------------------------------------------------------------------- */

describe('idle timeout', () => {
  it('terminates a quiet worker and spawns a fresh one on the next call', async () => {
    const { createWorker, spawned } = workerFactory(serves);
    const bridge = createWorkerBridge({
      createWorker,
      idleTimeoutMs: 20,
      watchdogMs: Infinity,
    });
    const signal = new AbortController().signal;
    const options = defaultOptionsFor('webp');

    await bridge.encode(signal, 'webp', image(), options);
    expect(spawned[0]?.terminated).toBe(0);

    await sleep(60);
    expect(spawned[0]?.terminated).toBe(1);

    const result = await bridge.encode(signal, 'webp', image(), options);
    expect(result.byteLength).toBe(ENCODED_BYTES);
    expect(spawned.length).toBe(2);
    // An idle terminate is not a load failure: threads stay on.
    expect(spawned[1]?.nothreads).toBe(false);

    bridge.terminate();
  });
});

describe('watchdog', () => {
  it('reclaims a worker that stopped answering', async () => {
    const { createWorker, spawned } = workerFactory(wedges, serves);
    const bridge = createWorkerBridge({
      createWorker,
      idleTimeoutMs: Infinity,
      watchdogMs: 20,
    });
    const signal = new AbortController().signal;
    const options = defaultOptionsFor('webp');

    await expect(
      bridge.encode(signal, 'webp', image(), options),
    ).rejects.toBeInstanceOf(WorkerTimeoutError);
    expect(spawned[0]?.terminated).toBe(1);

    // A timeout is ambiguous — a genuinely heavy encode fires it too — so it
    // deliberately does *not* latch single-threaded mode the way a load error
    // does. The next worker still asks for threads.
    const result = await bridge.encode(signal, 'webp', image(), options);
    expect(result.byteLength).toBe(ENCODED_BYTES);
    expect(spawned.map((worker) => worker.nothreads)).toEqual([false, false]);
  });
});

/* -------------------------------------------------------------------------- */
/* Abort                                                                       */
/* -------------------------------------------------------------------------- */

describe('abort', () => {
  it('terminates the worker and rejects the call in flight', async () => {
    const { createWorker, spawned } = workerFactory(wedges);
    const bridge = createWorkerBridge({ createWorker, ...inert });
    const controller = new AbortController();

    const call = bridge.encode(
      controller.signal,
      'webp',
      image(),
      defaultOptionsFor('webp'),
    );
    await sleep();
    controller.abort();

    await expect(call).rejects.toHaveProperty('name', 'AbortError');
    expect(spawned[0]?.terminated).toBe(1);
  });
});
