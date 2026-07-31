/**
 * `createPdfJob` — the phase machine, with every engine call injected.
 *
 * Same technique as `compress.test.ts`: no canvas, no worker, no real PDF. The
 * point of these tests is the state transitions, and above all the two that
 * would lie to the user if they broke — a refused document must never reach
 * `compressPdf` (which reports refusals as a silent 0% saving), and pressing
 * Stop must not look like a failure.
 *
 * The preview half is here for the same reason: what it must never do is hold
 * pixels it is not showing, keep rendering a page the user has left, or hand
 * pdf.js the very buffer the download button is going to write.
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
import {
  cachePreviewPages,
  createPdfJob,
  pdfRefusalMessage,
  PDF_PREVIEW_CACHE_LIMIT,
  type PdfJob,
} from './pdf-job.svelte';
import type { PdfRenderer, RenderedPage } from './render';

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

/**
 * A pair of documents that rasterise nothing.
 *
 * Node has no `ImageData` and the job only ever passes the pixels through, so
 * the pages are empty objects; what the fake actually records is the traffic —
 * which buffers were opened, which pages were asked for, how many handles were
 * closed.
 */
function fakeRenderers(
  options: {
    pageCount?: number;
    /** Never settle this page, so an abort has something to cancel. */
    hangOn?: number;
    /** Reject this page with a message. */
    failOn?: number;
    /** Take a turn of the event loop to open, so teardown can race it. */
    slowOpen?: boolean;
  } = {},
) {
  const pageCount = options.pageCount ?? 3;
  const opened: ArrayBuffer[] = [];
  /** `${document}:${page}`, in call order. Document 0 is the original. */
  const rendered: string[] = [];
  let destroyed = 0;

  const open = async (bytes: ArrayBuffer): Promise<PdfRenderer> => {
    const doc = opened.length;
    opened.push(bytes);
    if (options.slowOpen) await tick();

    const renderer: PdfRenderer = {
      pageCount,
      pageSize: async () => ({ width: 595, height: 842 }),
      render: (signal, pageIndex) => {
        rendered.push(`${doc}:${pageIndex}`);
        if (pageIndex === options.failOn) return Promise.reject(new Error('page is broken'));
        if (pageIndex !== options.hangOn) {
          return Promise.resolve<RenderedPage>({ data: {} as ImageData, width: 8, height: 8 });
        }
        return new Promise<RenderedPage>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(abortError()));
        });
      },
      destroy: () => {
        destroyed += 1;
      },
    };
    return renderer;
  };

  return {
    open,
    opened,
    rendered,
    get destroyed(): number {
      return destroyed;
    },
  };
}

/** A job parked in `done`, ready to preview `pageCount` pages. */
async function previewJob(
  renderers: ReturnType<typeof fakeRenderers>,
  pageCount = 3,
): Promise<PdfJob> {
  const job = createPdfJob(pdfFile(), {
    analyze: fakeAnalyze(analysisOf([imageInfo('4 0 R')], pageCount)),
    compress: async () => resultOf(1200),
    openRenderer: renderers.open,
  });
  await job.analyze();
  await job.compress();
  return job;
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

/* -------------------------------------------------------------------------- */
/* Preview cache                                                               */
/* -------------------------------------------------------------------------- */

describe('cachePreviewPages', () => {
  it('puts the newest pair at the head', () => {
    expect(cachePreviewPages([{ pageIndex: 0 }], { pageIndex: 1 })).toEqual([
      { pageIndex: 1 },
      { pageIndex: 0 },
    ]);
  });

  it('evicts past the ceiling — two pairs is already ~40 MB', () => {
    let cache: Array<{ pageIndex: number }> = [];
    for (const pageIndex of [0, 1, 2]) cache = cachePreviewPages(cache, { pageIndex });

    expect(PDF_PREVIEW_CACHE_LIMIT).toBe(2);
    expect(cache).toEqual([{ pageIndex: 2 }, { pageIndex: 1 }]);
  });

  it('moves a hit back to the head instead of duplicating it', () => {
    const cache = cachePreviewPages([{ pageIndex: 1 }, { pageIndex: 0 }], { pageIndex: 0 });

    expect(cache).toEqual([{ pageIndex: 0 }, { pageIndex: 1 }]);
  });

  it('never mutates the array it was handed', () => {
    const cache = [{ pageIndex: 0 }];
    cachePreviewPages(cache, { pageIndex: 1 });

    expect(cache).toEqual([{ pageIndex: 0 }]);
  });

  it('holds nothing at all when the limit is zero', () => {
    expect(cachePreviewPages([{ pageIndex: 0 }], { pageIndex: 1 }, 0)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Preview                                                                     */
/* -------------------------------------------------------------------------- */

describe('PdfJob.showPage', () => {
  it('renders both documents and hands over the pair', async () => {
    const renderers = fakeRenderers();
    const job = await previewJob(renderers);

    expect(job.pageCount).toBe(3);
    expect(job.canPreview).toBe(true);
    await job.showPage(0);

    expect(job.preview?.pageIndex).toBe(0);
    expect(job.preview?.original.width).toBe(8);
    expect(job.preview?.output.width).toBe(8);
    expect(job.previewLoading).toBe(false);
    expect(job.previewError).toBeUndefined();
    expect(renderers.rendered).toEqual(['0:0', '1:0']);
  });

  it('renders nothing during compression — the pixels are pulled on demand', async () => {
    const renderers = fakeRenderers();
    await previewJob(renderers);

    expect(renderers.opened).toHaveLength(0);
    expect(renderers.rendered).toEqual([]);
  });

  it('clamps out of range, so the view can wire its arrows to ±1', async () => {
    const renderers = fakeRenderers();
    const job = await previewJob(renderers);

    await job.showPage(9);
    expect(job.previewPage).toBe(2);

    await job.showPage(-4);
    expect(job.previewPage).toBe(0);
  });

  it('shows nothing until there is an output to compare against', async () => {
    const renderers = fakeRenderers();
    const job = createPdfJob(pdfFile(), {
      analyze: fakeAnalyze(analysisOf([imageInfo('4 0 R')], 3)),
      openRenderer: renderers.open,
    });
    await job.analyze();

    await job.showPage(1);

    expect(job.canPreview).toBe(false);
    expect(job.preview).toBeUndefined();
    expect(job.previewLoading).toBe(false);
    expect(renderers.opened).toHaveLength(0);
    // The number still moves: the page selector is usable before a run.
    expect(job.previewPage).toBe(1);
  });

  it('holds both documents open across page changes', async () => {
    const renderers = fakeRenderers();
    const job = await previewJob(renderers);

    await job.showPage(0);
    await job.showPage(1);

    expect(renderers.opened).toHaveLength(2);
    expect(renderers.rendered).toEqual(['0:0', '1:0', '0:1', '1:1']);
  });

  it('serves a page it has already rendered from the cache', async () => {
    const renderers = fakeRenderers();
    const job = await previewJob(renderers);

    await job.showPage(0);
    await job.showPage(1);
    await job.showPage(0);

    expect(renderers.rendered).toHaveLength(4);
    expect(job.preview?.pageIndex).toBe(0);
    expect(job.previewLoading).toBe(false);
  });

  it('re-renders a page the two-pair ceiling evicted', async () => {
    const renderers = fakeRenderers();
    const job = await previewJob(renderers);

    for (const page of [0, 1, 2, 0]) await job.showPage(page);

    expect(renderers.rendered).toEqual([
      '0:0', '1:0',
      '0:1', '1:1',
      '0:2', '1:2',
      '0:0', '1:0',
    ]);
  });

  it('copies the output bytes — pdf.js may detach what the download writes', async () => {
    const renderers = fakeRenderers();
    const job = await previewJob(renderers);

    await job.showPage(0);

    expect(renderers.opened[1]).not.toBe(job.result?.bytes);
    expect(renderers.opened[1]?.byteLength).toBe(job.result?.bytes.byteLength);
  });

  it('aborts the render in flight when the page changes', async () => {
    const renderers = fakeRenderers({ hangOn: 0 });
    const job = await previewJob(renderers);

    const stale = job.showPage(0);
    await tick();
    expect(job.previewLoading).toBe(true);

    await job.showPage(1);
    await stale;

    expect(job.preview?.pageIndex).toBe(1);
    expect(job.previewLoading).toBe(false);
    // Leaving a page is not a failure, exactly as Stop is not a failure.
    expect(job.previewError).toBeUndefined();
  });

  it('reports a render failure without disturbing the result', async () => {
    const renderers = fakeRenderers({ failOn: 1 });
    const job = await previewJob(renderers);

    await job.showPage(1);

    expect(job.previewError).toBe('page is broken');
    expect(job.preview).toBeUndefined();
    expect(job.previewLoading).toBe(false);
    expect(job.phase).toBe('done');
    expect(job.result).toBeDefined();

    // Asking for another page clears the sentence before it renders.
    await job.showPage(0);
    expect(job.previewError).toBeUndefined();
    expect(job.preview?.pageIndex).toBe(0);
  });

  it('drops the last good page when a later one fails to render', async () => {
    const renderers = fakeRenderers({ failOn: 1 });
    const job = await previewJob(renderers);

    await job.showPage(0);
    expect(job.preview?.pageIndex).toBe(0);

    // `previewPage` moved to 1 before the render started and the view captions
    // the panes from it, so leaving page 0's pixels up would label them as the
    // page that just failed.
    await job.showPage(1);
    expect(job.previewPage).toBe(1);
    expect(job.previewError).toBe('page is broken');
    expect(job.preview).toBeUndefined();
  });

  it('drops the preview and both handles when another run starts', async () => {
    const renderers = fakeRenderers();
    const job = await previewJob(renderers);
    await job.showPage(1);

    await job.compress();
    await tick();

    expect(job.preview).toBeUndefined();
    expect(renderers.destroyed).toBe(2);
    // The page survives: a re-run changes the settings, not the document.
    expect(job.previewPage).toBe(1);

    await job.showPage(1);
    expect(renderers.opened).toHaveLength(4);
    expect(job.preview?.pageIndex).toBe(1);
  });

  it('drops the preview when the document is analysed again', async () => {
    const renderers = fakeRenderers();
    const job = await previewJob(renderers);
    await job.showPage(2);

    await job.analyze();
    await tick();

    expect(job.preview).toBeUndefined();
    expect(job.previewPage).toBe(0);
    expect(renderers.destroyed).toBe(2);
  });

  it('destroys both documents on dispose', async () => {
    const renderers = fakeRenderers();
    const job = await previewJob(renderers);
    await job.showPage(1);

    job.dispose();
    await tick();

    expect(renderers.destroyed).toBe(2);
    expect(job.preview).toBeUndefined();
  });

  it('opens again after a failed open, instead of replaying the rejection', async () => {
    // The failures this guards against are transient by nature — a chunk that
    // 404s mid-deploy, a `PdfWorkerError` from a worker cached without the
    // COEP header — and their message tells the user to reload and try again.
    // Caching the rejected promise would make every later arrow press reproduce
    // it with no attempt at all, and only a recompress could clear it.
    const working = fakeRenderers();
    let attempts = 0;
    const openRenderer = async (bytes: ArrayBuffer): Promise<PdfRenderer> => {
      attempts += 1;
      if (attempts === 1) throw new Error('worker would not start');
      return working.open(bytes);
    };

    const job = createPdfJob(pdfFile(), {
      analyze: fakeAnalyze(analysisOf([imageInfo('4 0 R')], 3)),
      compress: async () => resultOf(1200),
      openRenderer,
    });
    await job.analyze();
    await job.compress();

    await job.showPage(0);
    expect(job.previewError).toBe('worker would not start');
    expect(job.preview).toBeUndefined();

    await job.showPage(1);
    expect(job.previewError).toBeUndefined();
    expect(job.preview?.pageIndex).toBe(1);
  });

  it('stops the sibling render when one side of the pair fails', async () => {
    // `Promise.all` rejects on the first rejection and leaves the other render
    // running: rAF slices on the UI thread, ending in a multi-megabyte readback
    // for a page the user has already been told failed.
    let opened = 0;
    let aborted = false;
    const openRenderer = async (): Promise<PdfRenderer> => {
      // Document 0 is the original, as everywhere else here: it fails the page,
      // and the output side hangs until something aborts it.
      const doc = opened++;
      return {
        pageCount: 3,
        pageSize: async () => ({ width: 595, height: 842 }),
        render: (signal, pageIndex) =>
          doc === 0 && pageIndex === 1
            ? Promise.reject(new Error('page is broken'))
            : new Promise<RenderedPage>((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                  aborted = true;
                  reject(abortError());
                });
              }),
        destroy: () => undefined,
      };
    };

    const job = createPdfJob(pdfFile(), {
      analyze: fakeAnalyze(analysisOf([imageInfo('4 0 R')], 3)),
      compress: async () => resultOf(1200),
      openRenderer,
    });
    await job.analyze();
    await job.compress();

    await job.showPage(1);

    expect(job.previewError).toBe('page is broken');
    expect(aborted).toBe(true);
  });

  it('closes documents that were still opening when the job was disposed', async () => {
    const renderers = fakeRenderers({ slowOpen: true });
    const job = await previewJob(renderers);

    const showing = job.showPage(0);
    job.dispose();
    await showing;
    await tick();

    expect(renderers.opened).toHaveLength(2);
    expect(renderers.rendered).toEqual([]);
    expect(renderers.destroyed).toBe(2);
  });
});
