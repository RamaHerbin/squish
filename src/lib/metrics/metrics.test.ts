/**
 * Metrics tests.
 *
 * Everything here runs in plain node: `MetricsImage` is a structural
 * `{ data, width, height }`, so no `ImageData` constructor and no canvas is
 * needed, and the worker is replaced by a fake that answers on a microtask.
 */

import { describe, expect, it, vi } from 'vitest';

import { isAbortError } from '../contracts';
import { MetricsClient } from './metrics-client';
import {
  handleMetricsRequest,
  type MetricsRequest,
  type MetricsResponse,
} from './metrics.worker';
import {
  computeSsim,
  downscaleBy,
  downscaleForMetrics,
  downscalePairForMetrics,
  measureSsim,
  metricsScaleFactor,
  sameDimensions,
  toLuma,
  type MetricsImage,
} from './ssim';
import { captionFor, formatButteraugli, formatSsim, toneAccent, verdictFor } from './verdict';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

type Pixel = readonly [number, number, number, number];

function image(
  width: number,
  height: number,
  at: (x: number, y: number) => Pixel,
): MetricsImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = at(x, y);
      const p = (y * width + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = a;
    }
  }
  return { data, width, height };
}

const solid = (width: number, height: number, value: number): MetricsImage =>
  image(width, height, () => [value, value, value, 255]);

/** Values stay under 226 so `offset` never clips against the 255 ceiling. */
const gradient = (width: number, height: number, offset = 0): MetricsImage =>
  image(width, height, (x, y) => {
    const v = ((x * 7 + y * 11) % 200) + offset;
    return [v, v, v, 255];
  });

/** Deterministic pseudo-noise, so the "structure differs" test never flakes. */
function noise(width: number, height: number, seed = 1): MetricsImage {
  let state = seed;
  return image(width, height, () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    const v = (state >>> 16) % 256;
    return [v, v, v, 255];
  });
}

async function expectAbortError(promise: Promise<unknown>): Promise<void> {
  const reason = await promise.then(
    () => new Error('expected an AbortError, but the promise resolved'),
    (error: unknown) => error,
  );
  expect(isAbortError(reason)).toBe(true);
}

/* -------------------------------------------------------------------------- */
/* SSIM                                                                        */
/* -------------------------------------------------------------------------- */

describe('computeSsim', () => {
  it('scores identical images exactly 1', () => {
    expect(computeSsim(gradient(32, 32), gradient(32, 32))).toBe(1);
  });

  it('scores an image against itself as 1', () => {
    const a = noise(16, 16);
    expect(computeSsim(a, a)).toBe(1);
  });

  it('drops below 1 for a constant luma shift', () => {
    const score = computeSsim(gradient(32, 32), gradient(32, 32, 30));
    expect(score).toBeLessThan(1);
    expect(score).toBeGreaterThan(0.5);
  });

  it('scores unrelated structure far lower than a mild shift', () => {
    const a = gradient(32, 32);
    const shifted = computeSsim(a, gradient(32, 32, 30));
    const unrelated = computeSsim(a, noise(32, 32, 7));
    expect(unrelated).toBeLessThan(shifted);
    expect(unrelated).toBeLessThan(0.5);
  });

  it('handles images smaller than one window', () => {
    expect(computeSsim(solid(4, 4, 120), solid(4, 4, 120))).toBe(1);
    expect(computeSsim(solid(4, 4, 120), solid(4, 4, 20))).toBeLessThan(1);
  });

  it('sees through alpha: transparent vs opaque with identical RGB differ', () => {
    // A transparent source encoded to JPEG keeps its hidden RGB but renders as
    // the page background — alpha must participate or this scores 1.
    const transparent = image(16, 16, (x) => [40, 40, 40, x < 8 ? 0 : 255]);
    const opaque = image(16, 16, () => [40, 40, 40, 255]);
    expect(computeSsim(transparent, opaque)).toBeLessThan(0.9);
    expect(computeSsim(transparent, transparent)).toBe(1);
  });

  it('scores pure noise against a flat field very low', () => {
    const score = computeSsim(solid(32, 32, 128), noise(32, 32, 3));
    expect(score).toBeLessThan(0.2);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('is monotone over a chain of increasing distortion (16x16 fixtures)', () => {
    const base = gradient(16, 16);
    const mild = computeSsim(base, gradient(16, 16, 5));
    const medium = computeSsim(base, gradient(16, 16, 20));
    const severe = computeSsim(base, gradient(16, 16, 45));
    expect(mild).toBeLessThan(1);
    expect(mild).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(severe);
  });

  it('throws when dimensions differ', () => {
    expect(() => computeSsim(solid(8, 8, 10), solid(8, 16, 10))).toThrow(RangeError);
    expect(sameDimensions(solid(8, 8, 10), solid(8, 16, 10))).toBe(false);
  });

  it('throws on an empty image', () => {
    expect(() => computeSsim(solid(0, 0, 0), solid(0, 0, 0))).toThrow(RangeError);
  });

  it('throws when the buffer is too short for the dimensions', () => {
    const broken: MetricsImage = { data: new Uint8ClampedArray(4), width: 4, height: 4 };
    expect(() => computeSsim(broken, broken)).toThrow(RangeError);
  });

  it('composites alpha over white before comparing', () => {
    const opaque = image(16, 16, (x) => [x * 8, x * 8, x * 8, 255]);
    const transparent = image(16, 16, (x) => [x * 8, x * 8, x * 8, 0]);
    expect(computeSsim(opaque, transparent)).toBeLessThan(1);
    expect(computeSsim(transparent, transparent)).toBe(1);
  });
});

describe('toLuma', () => {
  it('applies the Rec.709 weights', () => {
    expect(toLuma(image(1, 1, () => [255, 0, 0, 255]))[0]).toBeCloseTo(0.2126 * 255, 4);
    expect(toLuma(image(1, 1, () => [0, 255, 0, 255]))[0]).toBeCloseTo(0.7152 * 255, 4);
    expect(toLuma(image(1, 1, () => [0, 0, 255, 255]))[0]).toBeCloseTo(0.0722 * 255, 4);
  });
});

/* -------------------------------------------------------------------------- */
/* Downscaling                                                                 */
/* -------------------------------------------------------------------------- */

describe('downscaling', () => {
  it('computes an integer box factor from the pixel budget', () => {
    expect(metricsScaleFactor(1000, 1000, 2_000_000)).toBe(1);
    expect(metricsScaleFactor(2000, 2000, 2_000_000)).toBe(2);
    expect(metricsScaleFactor(6000, 4000, 2_000_000)).toBe(4);
    expect(metricsScaleFactor(6000, 4000, 0)).toBe(1);
  });

  it('returns the same object when nothing needs doing', () => {
    const small = solid(8, 8, 10);
    expect(downscaleForMetrics(small)).toBe(small);
    expect(downscaleBy(small, 1)).toBe(small);
  });

  it('averages each box', () => {
    const source = image(4, 4, (x, y) => {
      const v = (x < 2 && y < 2) || (x >= 2 && y >= 2) ? 200 : 100;
      return [v, v, v, 255];
    });
    const out = downscaleBy(source, 2);
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect(Array.from(out.data.slice(0, 4))).toEqual([200, 200, 200, 255]);
    expect(Array.from(out.data.slice(4, 8))).toEqual([100, 100, 100, 255]);
  });

  it('drops the ragged edge rather than resampling it', () => {
    const out = downscaleBy(solid(5, 5, 40), 2);
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
  });

  it('scales a pair with one shared factor', () => {
    const pair = downscalePairForMetrics(gradient(40, 40), gradient(40, 40), 100);
    expect(pair.factor).toBe(4);
    expect(pair.a.width).toBe(pair.b.width);
    expect(pair.a.height).toBe(pair.b.height);
    expect(() => downscalePairForMetrics(solid(8, 8, 1), solid(16, 16, 1), 100)).toThrow(
      RangeError,
    );
  });

  it('still scores identical images as 1 after a reduction', () => {
    expect(measureSsim(gradient(64, 64), gradient(64, 64), 256)).toBe(1);
  });

  it('downscaleForMetrics halves same-sized images consistently, regardless of content', () => {
    // 64x64 = 4096px; a 2000px budget needs factor ceil(sqrt(4096/2000)) = 2.
    const a = downscaleForMetrics(gradient(64, 64), 2000);
    const b = downscaleForMetrics(noise(64, 64, 9), 2000);
    expect(a.width).toBe(32);
    expect(a.height).toBe(32);
    expect(b.width).toBe(32);
    expect(b.height).toBe(32);
  });
});

/* -------------------------------------------------------------------------- */
/* Worker protocol                                                             */
/* -------------------------------------------------------------------------- */

describe('handleMetricsRequest', () => {
  it('answers with an ssim and a duration', () => {
    const response = handleMetricsRequest({
      id: 7,
      a: gradient(16, 16),
      b: gradient(16, 16),
    });
    expect(response.id).toBe(7);
    expect(response.ok).toBe(true);
    if (response.ok) expect(response.ssim).toBe(1);
    expect(response.ms).toBeGreaterThanOrEqual(0);
  });

  it('reports a mismatch as a failure rather than throwing', () => {
    const response = handleMetricsRequest({ id: 1, a: solid(8, 8, 1), b: solid(4, 4, 1) });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error).toMatch(/identical dimensions/);
  });
});

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

type Responder = (request: MetricsRequest) => MetricsResponse | null;

class FakeWorker {
  readonly posted: MetricsRequest[] = [];
  terminated = 0;
  respond: Responder = handleMetricsRequest;

  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  postMessage(message: MetricsRequest): void {
    this.posted.push(message);
    const response = this.respond(message);
    if (response) queueMicrotask(() => this.emit('message', { data: response }));
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminated++;
  }

  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  asWorker(): Worker {
    return this as unknown as Worker;
  }
}

/** A macrotask turn: drains every pending microtask the client is waiting on. */
const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Answer a request the fake worker parked, in the order they were posted. */
function answer(worker: FakeWorker, index: number): void {
  const request = worker.posted[index];
  if (!request) throw new Error(`no request posted at index ${index}`);
  worker.emit('message', { data: handleMetricsRequest(request) });
}

describe('MetricsClient', () => {
  it('measures through the worker and reports the score', async () => {
    const worker = new FakeWorker();
    const client = new MetricsClient({ createWorker: () => worker.asWorker() });

    const result = await client.measure(gradient(16, 16), gradient(16, 16));
    expect(result.ssim).toBe(1);
    expect(result.error).toBeUndefined();
    expect(result.ms).toBeGreaterThanOrEqual(0);

    client.terminate();
  });

  it("copies the pixels instead of transferring the caller's buffers", async () => {
    const worker = new FakeWorker();
    const client = new MetricsClient({ createWorker: () => worker.asWorker() });

    const original = gradient(16, 16);
    const output = gradient(16, 16, 4);
    await client.measure(original, output);

    const request = worker.posted[0];
    expect(request).toBeDefined();
    expect(request?.a.data).not.toBe(original.data);
    expect(request?.b.data).not.toBe(output.data);
    expect(Array.from(request?.a.data.slice(0, 4) ?? [])).toEqual(
      Array.from(original.data.slice(0, 4)),
    );
    // The caller's buffers are still usable afterwards.
    expect(original.data.length).toBe(16 * 16 * 4);

    client.terminate();
  });

  it('short-circuits mismatched dimensions without spawning a worker', async () => {
    const createWorker = vi.fn(() => new FakeWorker().asWorker());
    const client = new MetricsClient({ createWorker });

    const result = await client.measure(solid(16, 16, 20), solid(8, 8, 20));
    expect(result.ssim).toBeNull();
    expect(result.error).toMatch(/dimensions differ/);
    expect(createWorker).not.toHaveBeenCalled();

    client.terminate();
  });

  it('reports a worker-side failure as an unmeasured result', async () => {
    const worker = new FakeWorker();
    worker.respond = (request) => ({ id: request.id, ok: false, error: 'nope', ms: 1 });
    const client = new MetricsClient({ createWorker: () => worker.asWorker() });

    const result = await client.measure(solid(16, 16, 10), solid(16, 16, 10));
    expect(result.ssim).toBeNull();
    expect(result.error).toBe('nope');

    client.terminate();
  });

  it('serialises calls onto one worker', async () => {
    const worker = new FakeWorker();
    worker.respond = () => null; // parked; the test answers by hand
    const client = new MetricsClient({ createWorker: () => worker.asWorker() });

    const first = client.measure(gradient(16, 16), gradient(16, 16));
    const second = client.measure(gradient(16, 16), gradient(16, 16, 2));

    await sleep();
    // The second request must not be posted until the first has answered.
    expect(worker.posted.length).toBe(1);

    answer(worker, 0);
    expect((await first).ssim).toBe(1);

    await sleep();
    expect(worker.posted.length).toBe(2);
    answer(worker, 1);
    expect((await second).ssim).toBeLessThan(1);
    expect(worker.terminated).toBe(0);

    client.terminate();
  });

  it('terminates on abort and rejects with an AbortError', async () => {
    const worker = new FakeWorker();
    worker.respond = () => null; // never answers
    const client = new MetricsClient({ createWorker: () => worker.asWorker() });

    const controller = new AbortController();
    const pending = client.measure(gradient(16, 16), gradient(16, 16), controller.signal);
    await sleep();
    expect(worker.posted.length).toBe(1);
    controller.abort();

    await expectAbortError(pending);
    expect(worker.terminated).toBe(1);
  });

  it('rejects an already-aborted signal without posting anything', async () => {
    const worker = new FakeWorker();
    const client = new MetricsClient({ createWorker: () => worker.asWorker() });
    const controller = new AbortController();
    controller.abort();

    await expectAbortError(
      client.measure(gradient(8, 8), gradient(8, 8), controller.signal),
    );
    expect(worker.posted.length).toBe(0);

    client.terminate();
  });

  it('respawns after an abort', async () => {
    const workers: FakeWorker[] = [];
    const client = new MetricsClient({
      createWorker: () => {
        const worker = new FakeWorker();
        // The first worker never answers, so the call has to be aborted.
        if (workers.length === 0) worker.respond = () => null;
        workers.push(worker);
        return worker.asWorker();
      },
    });

    const controller = new AbortController();
    const pending = client.measure(gradient(8, 8), gradient(8, 8), controller.signal);
    await sleep();
    controller.abort();
    await expectAbortError(pending);
    expect(workers.length).toBe(1);
    expect(workers[0]?.terminated).toBe(1);

    const result = await client.measure(gradient(8, 8), gradient(8, 8));
    expect(result.ssim).toBe(1);
    expect(workers.length).toBe(2);

    client.terminate();
  });

  it('terminates the worker once it has been idle', async () => {
    const worker = new FakeWorker();
    const client = new MetricsClient({
      createWorker: () => worker.asWorker(),
      idleTimeoutMs: 5,
    });

    await client.measure(gradient(8, 8), gradient(8, 8));
    expect(worker.terminated).toBe(0);
    await sleep(30);
    expect(worker.terminated).toBe(1);
  });

  it('surfaces a worker error as an unmeasured result', async () => {
    const worker = new FakeWorker();
    worker.respond = () => {
      queueMicrotask(() => worker.emit('error', { message: 'boom' }));
      return null;
    };
    const client = new MetricsClient({ createWorker: () => worker.asWorker() });

    const result = await client.measure(gradient(8, 8), gradient(8, 8));
    expect(result.ssim).toBeNull();
    expect(result.error).toMatch(/boom/);

    client.terminate();
  });
});

/* -------------------------------------------------------------------------- */
/* Verdicts                                                                    */
/* -------------------------------------------------------------------------- */

describe('captions', () => {
  it('follows the contract thresholds', () => {
    expect(captionFor(1).label).toBe('Mathematically identical');
    expect(captionFor(0.999).label).toBe('Below visible threshold');
    expect(captionFor(0.994).label).toBe('Below visible threshold');
    expect(captionFor(0.99).label).toBe('Looks identical');
    expect(captionFor(0.975).label).toBe('Minor loss on gradients');
    expect(captionFor(0.95).label).toBe('Visible loss');
    expect(captionFor(0.5).label).toBe('Heavy loss');
  });

  it('paints tones with the comp accents', () => {
    expect(captionFor(0.994).accent).toBe('green');
    expect(captionFor(0.975).accent).toBe('yellow');
    expect(captionFor(0.5).accent).toBe('red');
    expect(captionFor(null).accent).toBe('muted');
    expect(toneAccent('good')).toBe('green');
  });

  it('keeps a short variant for 390px', () => {
    expect(captionFor(0.994).short).toBe('Looks identical');
    expect(captionFor(null).short).toBe('Unmeasured');
  });

  it('formats numbers the way the comp prints them', () => {
    expect(formatSsim(0.9942)).toBe('0.994');
    expect(formatSsim(null)).toBe('—');
    expect(formatButteraugli(1.23)).toBe('1.2');
    expect(formatButteraugli(undefined)).toBe('—');
  });

  it('re-exports the contract verdict unchanged', () => {
    expect(verdictFor(0.999).label).toBe('Overkill');
    expect(verdictFor(null).label).toBe('Unmeasured');
  });
});

