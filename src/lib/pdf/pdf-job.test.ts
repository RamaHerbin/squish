/**
 * `createPdfJob` — the phase machine, with both engine calls injected.
 *
 * Same technique as `compress.test.ts`: no canvas, no worker, no real PDF. The
 * point of these tests is the state transitions, and above all the two that
 * would lie to the user if they broke — a refused document must never reach
 * `compressPdf` (which reports refusals as a silent 0% saving), and pressing
 * Stop must not look like a failure.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_PDF_SETTINGS } from '../contracts';
import type {
  PdfAnalysis,
  PdfCompressResult,
  PdfCompressSettings,
  PdfImageInfo,
  PdfRefusal,
} from '../contracts';

import type { compressPdf } from './compress';
import { createPdfJob, pdfRefusalMessage, type PdfJob } from './pdf-job.svelte';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function pdfFile(name = 'doc.pdf', bytes = 2048): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

function imageInfo(ref: string, srcBytes = 100_000): PdfImageInfo {
  return {
    ref,
    pageIndices: [0],
    width: 800,
    height: 600,
    filter: 'DCTDecode',
    colorSpace: '/DeviceRGB',
    bitsPerComponent: 8,
    hasSMask: false,
    isMask: false,
    hasCustomDecode: false,
    srcBytes,
    effectiveDpi: 300,
  };
}

function analysisOf(images: readonly PdfImageInfo[], pageCount = 2): PdfAnalysis {
  return {
    pageCount,
    srcBytes: 2048,
    images,
    imageBytes: images.reduce((sum, image) => sum + image.srcBytes, 0),
  };
}

function refusedAnalysis(refusal: PdfRefusal): PdfAnalysis {
  return { pageCount: 1, srcBytes: 2048, images: [], imageBytes: 0, refusal };
}

function resultOf(outBytes: number, srcBytes = 2048): PdfCompressResult {
  return {
    bytes: new ArrayBuffer(outBytes),
    srcBytes,
    outBytes,
    images: [{ ref: '4 0 R', srcBytes: 100_000, outBytes: 40_000 }],
    replaced: 1,
    deduped: 0,
    ms: 12,
  };
}

/** An `analyze` that always answers with `analysis`. */
function fakeAnalyze(analysis: PdfAnalysis): (bytes: ArrayBuffer | Uint8Array) => Promise<PdfAnalysis> {
  return async () => analysis;
}

const abortError = (): DOMException => new DOMException('The operation was aborted.', 'AbortError');

/** A `compress` that never settles until its signal aborts, then rejects. */
function abortableCompress(): typeof compressPdf {
  return (_bytes, _settings, deps = {}) =>
    new Promise<PdfCompressResult>((_resolve, reject) => {
      const signal = deps.signal;
      if (!signal) return;
      if (signal.aborted) reject(abortError());
      else signal.addEventListener('abort', () => reject(abortError()));
    });
}

/** Let the job get past `file.arrayBuffer()` and into the injected engine. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/* -------------------------------------------------------------------------- */
/* Analysis                                                                    */
/* -------------------------------------------------------------------------- */

describe('PdfJob.analyze', () => {
  it('starts in `analyzing` and lands in `ready` with the analysis', async () => {
    const analysis = analysisOf([imageInfo('4 0 R')]);
    const job = createPdfJob(pdfFile(), { analyze: fakeAnalyze(analysis) });

    expect(job.phase).toBe('analyzing');
    await job.analyze();

    expect(job.phase).toBe('ready');
    expect(job.analysis).toBe(analysis);
    expect(job.error).toBeUndefined();
    expect(job.settings).toEqual(DEFAULT_PDF_SETTINGS);
  });

  it('reports a read failure as `error`, not a refusal', async () => {
    const job = createPdfJob(pdfFile(), {
      analyze: async () => {
        throw new Error('file is gone');
      },
    });

    await job.analyze();

    expect(job.phase).toBe('error');
    expect(job.error).toBe('file is gone');
  });
});

describe('PdfJob refusals', () => {
  const cases: ReadonlyArray<readonly [PdfRefusal, string]> = [
    ['encrypted', 'This PDF is encrypted — remove the password first.'],
    ['signed', 'This PDF is digitally signed — compressing would break the signature.'],
    ['unreadable', 'This is not a PDF Pinch can read.'],
  ];

  for (const [refusal, message] of cases) {
    it(`refuses a ${refusal} document with its own message`, async () => {
      const job = createPdfJob(pdfFile(), { analyze: fakeAnalyze(refusedAnalysis(refusal)) });
      await job.analyze();

      expect(job.phase).toBe('refused');
      expect(job.error).toBe(message);
      expect(pdfRefusalMessage(refusal)).toBe(message);
    });
  }

  it('never reaches the compressor from `refused` — a fake 0% saving is worse than a refusal', async () => {
    let calls = 0;
    const job = createPdfJob(pdfFile(), {
      analyze: fakeAnalyze(refusedAnalysis('signed')),
      compress: async () => {
        calls += 1;
        return resultOf(2048);
      },
    });

    await job.analyze();
    await job.compress();

    expect(calls).toBe(0);
    expect(job.phase).toBe('refused');
    expect(job.result).toBeUndefined();
  });

  it('never reaches the compressor before an analysis has run', async () => {
    let calls = 0;
    const job = createPdfJob(pdfFile(), {
      analyze: fakeAnalyze(analysisOf([imageInfo('4 0 R')])),
      compress: async () => {
        calls += 1;
        return resultOf(2048);
      },
    });

    await job.compress();

    expect(calls).toBe(0);
    expect(job.phase).toBe('analyzing');
  });
});

/* -------------------------------------------------------------------------- */
/* Compression                                                                 */
/* -------------------------------------------------------------------------- */

describe('PdfJob.compress', () => {
  it('runs analyzing → ready → compressing → done, ticking progress', async () => {
    const analysis = analysisOf([imageInfo('4 0 R'), imageInfo('5 0 R')]);
    const result = resultOf(1200);
    const seen: Array<{ done: number; total: number }> = [];
    let job: PdfJob | undefined;

    const compress: typeof compressPdf = async (_bytes, _settings, deps = {}) => {
      seen.push({ ...(job?.progress ?? { done: -1, total: -1 }) });
      deps.onProgress?.(1, 2);
      seen.push({ ...(job?.progress ?? { done: -1, total: -1 }) });
      deps.onProgress?.(2, 2);
      seen.push({ ...(job?.progress ?? { done: -1, total: -1 }) });
      return result;
    };

    job = createPdfJob(pdfFile(), { analyze: fakeAnalyze(analysis), compress });

    expect(job.phase).toBe('analyzing');
    await job.analyze();
    expect(job.phase).toBe('ready');

    const running = job.compress();
    expect(job.phase).toBe('compressing');
    expect(job.progress).toEqual({ done: 0, total: 2 });
    await running;

    expect(job.phase).toBe('done');
    expect(job.result).toBe(result);
    expect(job.error).toBeUndefined();
    expect(seen).toEqual([
      { done: 0, total: 2 },
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);
  });

  it('hands the run a snapshot of the settings, not the live object', async () => {
    let received: PdfCompressSettings | undefined;
    const job = createPdfJob(pdfFile(), {
      analyze: fakeAnalyze(analysisOf([imageInfo('4 0 R')])),
      compress: async (_bytes, settings) => {
        received = settings;
        return resultOf(1200);
      },
    });

    await job.analyze();
    job.settings = { ...job.settings, imageQuality: 60, targetDpi: null };
    await job.compress();

    expect(received).toEqual({ ...DEFAULT_PDF_SETTINGS, imageQuality: 60, targetDpi: null });
    expect(received).not.toBe(job.settings);
  });

  it('rewinds to `ready` when the run is aborted', async () => {
    const job = createPdfJob(pdfFile(), {
      analyze: fakeAnalyze(analysisOf([imageInfo('4 0 R')])),
      compress: abortableCompress(),
    });

    await job.analyze();
    const running = job.compress();
    expect(job.phase).toBe('compressing');

    await tick();
    job.abort();
    await running;

    expect(job.phase).toBe('ready');
    expect(job.result).toBeUndefined();
    expect(job.error).toBeUndefined();
  });

  it('rewinds to `ready` when Stop lands before the run starts', async () => {
    let calls = 0;
    const job = createPdfJob(pdfFile(), {
      analyze: fakeAnalyze(analysisOf([imageInfo('4 0 R')])),
      compress: async () => {
        calls += 1;
        return resultOf(1200);
      },
    });

    await job.analyze();
    const running = job.compress();
    job.abort(); // still inside `file.arrayBuffer()`
    await running;

    expect(calls).toBe(0);
    expect(job.phase).toBe('ready');
  });

  it('rewinds to `ready` when a result arrives after the abort', async () => {
    // `compressPdf` only checks its signal between images: an abort landing in
    // the final `doc.save()` still resolves, and must not present an output.
    let job: PdfJob | undefined;
    const job2 = createPdfJob(pdfFile(), {
      analyze: fakeAnalyze(analysisOf([imageInfo('4 0 R')])),
      compress: async () => {
        job?.abort();
        return resultOf(1200);
      },
    });
    job = job2;

    await job2.analyze();
    await job2.compress();

    expect(job2.phase).toBe('ready');
    expect(job2.result).toBeUndefined();
  });

  it('reports a non-abort failure as `error` with its message', async () => {
    const job = createPdfJob(pdfFile(), {
      analyze: fakeAnalyze(analysisOf([imageInfo('4 0 R')])),
      compress: async () => {
        throw new Error('pdf-lib gave up');
      },
    });

    await job.analyze();
    await job.compress();

    expect(job.phase).toBe('error');
    expect(job.error).toBe('pdf-lib gave up');
    expect(job.result).toBeUndefined();
    // The analysis survived the failure, so the run is retryable in place —
    // otherwise the only way out is closing and reopening the document.
    expect(job.canCompress).toBe(true);
  });

  it('retries a failed run against the surviving analysis', async () => {
    let calls = 0;
    const job = createPdfJob(pdfFile(), {
      analyze: fakeAnalyze(analysisOf([imageInfo('4 0 R')])),
      compress: async () => {
        calls += 1;
        if (calls === 1) throw new Error('pdf-lib gave up');
        return resultOf(900);
      },
    });

    await job.analyze();
    await job.compress();
    expect(job.phase).toBe('error');

    await job.compress();

    expect(calls).toBe(2);
    expect(job.phase).toBe('done');
    expect(job.error).toBeUndefined();
    expect(job.result?.outBytes).toBe(900);
  });

  it('never re-arms compression for a refused document', async () => {
    const job = createPdfJob(pdfFile(), {
      analyze: fakeAnalyze(refusedAnalysis('signed')),
      compress: async () => resultOf(900),
    });

    await job.analyze();

    expect(job.phase).toBe('refused');
    expect(job.canCompress).toBe(false);
  });

  it('allows another run after `done`, replacing the previous result', async () => {
    let calls = 0;
    const job = createPdfJob(pdfFile(), {
      analyze: fakeAnalyze(analysisOf([imageInfo('4 0 R')])),
      compress: async () => {
        calls += 1;
        return resultOf(1000 + calls);
      },
    });

    await job.analyze();
    await job.compress();
    expect(job.phase).toBe('done');
    expect(job.result?.outBytes).toBe(1001);

    job.settings = { ...job.settings, imageQuality: 50 };
    await job.compress();

    expect(calls).toBe(2);
    expect(job.phase).toBe('done');
    expect(job.result?.outBytes).toBe(1002);
  });

  it('ignores a second press while a run is in flight', async () => {
    let calls = 0;
    const job = createPdfJob(pdfFile(), {
      analyze: fakeAnalyze(analysisOf([imageInfo('4 0 R')])),
      compress: (_bytes, _settings, deps = {}) => {
        calls += 1;
        return new Promise<PdfCompressResult>((_resolve, reject) => {
          deps.signal?.addEventListener('abort', () => reject(abortError()));
        });
      },
    });

    await job.analyze();
    const first = job.compress();
    await tick();
    await job.compress();

    expect(calls).toBe(1);
    job.abort();
    await first;
    expect(job.phase).toBe('ready');
  });

  it('dispose aborts an in-flight run', async () => {
    const job = createPdfJob(pdfFile(), {
      analyze: fakeAnalyze(analysisOf([imageInfo('4 0 R')])),
      compress: abortableCompress(),
    });

    await job.analyze();
    const running = job.compress();
    await tick();
    job.dispose();
    await running;

    expect(job.phase).toBe('ready');
  });

  it('is a no-op when there is nothing in flight to abort', async () => {
    const job = createPdfJob(pdfFile(), {
      analyze: fakeAnalyze(analysisOf([imageInfo('4 0 R')])),
    });

    await job.analyze();
    expect(() => job.abort()).not.toThrow();
    expect(() => job.dispose()).not.toThrow();
    expect(job.phase).toBe('ready');
  });
});
