import { describe, expect, it, vi } from 'vitest';

import {
  createSideSettings,
  progressFraction,
  type BatchItem,
  type SideSettings,
  type WorkerBridgeApi,
} from '../contracts';
import {
  basename,
  dirname,
  joinPath,
  looksLikeImage,
  pickedFilesFromFileList,
  pickedFilesFromSnapshot,
  sanitizeZipPath,
  type DropSnapshot,
} from './files';
import {
  ENCODER_LABELS,
  formatBytes,
  formatResize,
  formatSaved,
  qualityOf,
  savedFraction,
  settingsFacts,
  splitPath,
} from './format';
import { BATCH_ENCODER_OUTPUT, encodeBatchFile, outputNameFor } from './pipeline';
import { createBatchQueue } from './queue.svelte';
import { createThumbnailCache } from './thumbnails';
import { exportZip, zipEntryPath, zippableItems } from './zip';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function makeFile(name: string, size: number, type = 'image/png'): File {
  return new File([new Uint8Array(size)], name, { type, lastModified: 1 });
}

/** A bridge that fails loudly: the tests that run the queue stub the pipeline. */
function stubBridge(): WorkerBridgeApi {
  return {
    decode: vi.fn(async () => {
      throw new Error('not used');
    }),
    encode: vi.fn(async () => new ArrayBuffer(0)),
    resize: vi.fn(async (_signal, data) => data),
    rotate: vi.fn(async (_signal, data) => data),
    preload: vi.fn(),
    terminate: vi.fn(),
  };
}

function doneItem(name: string, outName: string, bytes: Uint8Array<ArrayBuffer>): BatchItem {
  return {
    id: `${name}:${outName}`,
    name,
    status: 'done',
    srcSize: bytes.length * 4,
    outSize: bytes.length,
    file: makeFile(basename(name), bytes.length * 4),
    outFile: new File([bytes], outName, { type: 'image/jpeg' }),
  };
}

const bytes = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

/* -------------------------------------------------------------------------- */
/* Paths and ingestion                                                         */
/* -------------------------------------------------------------------------- */

describe('paths', () => {
  it('splits and joins', () => {
    expect(basename('a/b/c.png')).toBe('c.png');
    expect(basename('c.png')).toBe('c.png');
    expect(dirname('a/b/c.png')).toBe('a/b');
    expect(dirname('c.png')).toBe('');
    expect(joinPath('a/b', 'c.png')).toBe('a/b/c.png');
    expect(joinPath('', 'c.png')).toBe('c.png');
  });

  it('strips traversal segments from zip paths', () => {
    expect(sanitizeZipPath('../../etc/passwd')).toBe('etc/passwd');
    expect(sanitizeZipPath('/leading/slash.png')).toBe('leading/slash.png');
    expect(sanitizeZipPath('C:\\photos\\a.png')).toBe('photos/a.png');
    expect(sanitizeZipPath('./a/./b.png')).toBe('a/b.png');
  });

  it('recognises images by type or extension', () => {
    expect(looksLikeImage(makeFile('a.png', 1))).toBe(true);
    expect(looksLikeImage(makeFile('a.jxl', 1, ''))).toBe(true);
    expect(looksLikeImage(makeFile('notes.txt', 1, 'text/plain'))).toBe(false);
  });
});

describe('pickedFilesFromFileList', () => {
  it('keeps images, drops junk, and honours the file cap', () => {
    const picked = pickedFilesFromFileList([
      makeFile('a.png', 10),
      makeFile('readme.txt', 10, 'text/plain'),
      makeFile('.DS_Store', 10, ''),
      makeFile('b.jpg', 10, 'image/jpeg'),
    ]);
    expect(picked.map((entry) => entry.path)).toEqual(['a.png', 'b.jpg']);

    const capped = pickedFilesFromFileList(
      [makeFile('a.png', 1), makeFile('b.png', 1), makeFile('c.png', 1)],
      { maxFiles: 2 },
    );
    expect(capped).toHaveLength(2);
  });
});

describe('folder traversal', () => {
  /**
   * Minimal stand-ins for the entries a folder drop produces. The files carry
   * no MIME type, which is the awkward real-world case: the extension is all
   * the filter has to go on.
   */
  function fileEntry(name: string): FileSystemEntry {
    return {
      name,
      isFile: true,
      isDirectory: false,
      file: (resolve: (file: File) => void) => resolve(makeFile(name, 32, '')),
    } as unknown as FileSystemEntry;
  }

  function dirEntry(name: string, children: FileSystemEntry[]): FileSystemEntry {
    return {
      name,
      isFile: false,
      isDirectory: true,
      createReader() {
        // readEntries() drains in batches and must end with an empty one.
        let served = false;
        return {
          readEntries(resolve: (entries: FileSystemEntry[]) => void) {
            resolve(served ? [] : children);
            served = true;
          },
        };
      },
    } as unknown as FileSystemEntry;
  }

  it('walks nested folders and keeps relative paths', async () => {
    const snapshot: DropSnapshot = {
      entries: [
        dirEntry('holiday', [
          fileEntry('beach.png'),
          dirEntry('raw', [fileEntry('sunset.jpg'), fileEntry('notes.txt')]),
        ]),
        fileEntry('loose.png'),
      ],
      files: [],
    };

    const picked = await pickedFilesFromSnapshot(snapshot);
    expect(picked.map((entry) => entry.path).sort()).toEqual([
      'holiday/beach.png',
      'holiday/raw/sunset.jpg',
      'loose.png',
    ]);
  });

  it('stops at the depth limit instead of recursing forever', async () => {
    const deep = dirEntry('a', [dirEntry('b', [dirEntry('c', [fileEntry('deep.png')])])]);
    const picked = await pickedFilesFromSnapshot({ entries: [deep], files: [] }, { maxDepth: 1 });
    expect(picked).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

describe('formatting', () => {
  it('formats byte sizes the way a file browser does', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(948)).toBe('948 B');
    expect(formatBytes(12_400)).toBe('12.4 kB');
    expect(formatBytes(1_240_000)).toBe('1.24 MB');
  });

  it('reports savings, including negative ones', () => {
    expect(savedFraction(1000, 220)).toBeCloseTo(0.78);
    expect(savedFraction(1000, undefined)).toBeUndefined();
    expect(formatSaved(0.78)).toBe('-78%');
    expect(formatSaved(-0.04)).toBe('+4%');
    expect(formatSaved(0)).toBe('0%');
  });

  it('splits a path into folder and filename', () => {
    expect(splitPath('a/b/c.png')).toEqual({ folder: 'a/b/', name: 'c.png' });
    expect(splitPath('c.png')).toEqual({ folder: '', name: 'c.png' });
  });

  it('summarises the settings applied to the batch', () => {
    const settings = createSideSettings('mozjpeg', { quality: 82 });
    expect(settingsFacts(settings)).toEqual([
      { label: 'Format', value: 'MozJPEG' },
      { label: 'Quality', value: '82' },
      { label: 'Resize', value: 'Original size' },
    ]);

    const resized = createSideSettings('webp', undefined, {
      resize: {
        enabled: true,
        width: 1200,
        height: 800,
        method: 'lanczos3',
        premultiply: true,
        linearRGB: true,
        fitMethod: 'contain',
      },
    });
    expect(formatResize(resized.processorState.resize)).toBe('1200 x 800 contain');
    expect(qualityOf(resized)).toBe(75);
    expect(qualityOf(createSideSettings('browser-jpeg', { quality: 0.8 }))).toBe(80);
    expect(qualityOf(createSideSettings('oxipng'))).toBeUndefined();
  });

  it('labels every encoder', () => {
    for (const id of Object.keys(ENCODER_LABELS)) {
      expect(ENCODER_LABELS[id as keyof typeof ENCODER_LABELS]).toBeTruthy();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Pipeline naming                                                             */
/* -------------------------------------------------------------------------- */

describe('output naming', () => {
  it('keeps the basename and swaps the extension', () => {
    expect(outputNameFor('holiday/beach.png', 'mozjpeg')).toBe('beach.jpg');
    expect(outputNameFor('beach.png', 'webp')).toBe('beach.webp');
    expect(outputNameFor('beach.png', 'avif')).toBe('beach.avif');
    expect(outputNameFor('no-extension', 'oxipng')).toBe('no-extension.png');
  });

  it('leaves identity output untouched', () => {
    expect(outputNameFor('beach.png', 'identity')).toBe('beach.png');
    expect(BATCH_ENCODER_OUTPUT.identity).toEqual({ mimeType: '', extension: '' });
  });

  it('passes the original file through for identity, without decoding', async () => {
    const bridge = stubBridge();
    const source = makeFile('beach.png', 128);
    const out = await encodeBatchFile(
      new AbortController().signal,
      source,
      createSideSettings('identity'),
      { bridge },
    );
    expect(out).toBe(source);
    expect(bridge.decode).not.toHaveBeenCalled();
    expect(bridge.encode).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Queue                                                                       */
/* -------------------------------------------------------------------------- */

/** A queue whose pipeline is a stub, so the tests exercise scheduling only. */
function testQueue(
  options: {
    concurrency?: number;
    encodeFile?: Parameters<typeof createBatchQueue>[0]['encodeFile'];
  } = {},
) {
  const terminate = vi.fn();
  const queue = createBatchQueue({
    createWorkerBridge: () => ({ ...stubBridge(), terminate }),
    stage: null,
    concurrency: options.concurrency ?? 2,
    encodeFile:
      options.encodeFile ??
      (async (_signal, file) =>
        new File([new Uint8Array(Math.floor(file.size / 4))], file.name, {
          type: 'image/jpeg',
        })),
  });
  return { queue, terminate };
}

const anySettings = (): SideSettings => createSideSettings('mozjpeg');

describe('batch queue', () => {
  it('encodes every pending item and accounts for the bytes', async () => {
    const { queue } = testQueue();
    queue.add([makeFile('a.png', 1000), makeFile('b.png', 2000), makeFile('c.png', 4000)]);

    expect(queue.progress.total).toBe(3);
    expect(queue.progress.running).toBe(false);
    expect(progressFraction(queue.progress)).toBe(0);

    await queue.start(anySettings());

    expect(queue.items.every((item) => item.status === 'done')).toBe(true);
    expect(queue.progress.bytesIn).toBe(7000);
    expect(queue.progress.bytesOut).toBe(1750);
    expect(queue.progress.running).toBe(false);
    expect(progressFraction(queue.progress)).toBe(1);
    expect(queue.items[0]?.outFile?.name).toBe('a.png');
  });

  it('never runs more than `concurrency` items at once', async () => {
    let active = 0;
    let peak = 0;
    const { queue } = testQueue({
      concurrency: 2,
      encodeFile: async (_signal, file) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        return new File([new Uint8Array(1)], file.name);
      },
    });

    queue.add(Array.from({ length: 6 }, (_unused, index) => makeFile(`f${index}.png`, 100)));
    await queue.start(anySettings());

    expect(peak).toBeLessThanOrEqual(2);
    expect(queue.progress.done).toBe(6);
  });

  it('marks a failing item and keeps going', async () => {
    const { queue } = testQueue({
      encodeFile: async (_signal, file) => {
        if (file.name === 'bad.png') throw new Error('decode blew up');
        return new File([new Uint8Array(1)], file.name);
      },
    });
    queue.add([makeFile('ok.png', 100), makeFile('bad.png', 100), makeFile('fine.png', 100)]);
    await queue.start(anySettings());

    expect(queue.progress.done).toBe(2);
    expect(queue.progress.errored).toBe(1);
    const bad = queue.items.find((item) => item.name === 'bad.png');
    expect(bad?.error).toBe('decode blew up');

    expect(queue.retryFailed()).toBe(1);
    expect(bad?.status).toBe('pending');
    expect(bad?.error).toBeUndefined();
  });

  it('cancels in flight work, keeps finished results, and resumes', async () => {
    const { queue, terminate } = testQueue({
      concurrency: 1,
      encodeFile: (signal, file) =>
        new Promise<File>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new File([new Uint8Array(1)], file.name)), 20);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    queue.add([makeFile('x.png', 100), makeFile('y.png', 100), makeFile('z.png', 100)]);

    const run = queue.start(anySettings());
    await new Promise((resolve) => setTimeout(resolve, 30));
    queue.cancel();
    await run;

    expect(terminate).toHaveBeenCalled();
    expect(queue.progress.done).toBe(1);
    expect(queue.items.filter((item) => item.status === 'pending')).toHaveLength(2);
    expect(queue.progress.running).toBe(false);

    await queue.start(anySettings());
    expect(queue.progress.done).toBe(3);
  });

  it('snapshots the settings so later edits cannot affect a run', async () => {
    const seen: string[] = [];
    const { queue } = testQueue({
      encodeFile: async (_signal, file, settings) => {
        seen.push(settings.encoderId);
        return new File([new Uint8Array(1)], file.name);
      },
    });
    queue.add([makeFile('a.png', 10)]);

    const settings = createSideSettings('webp');
    const run = queue.start(settings);
    settings.encoderOptions.quality = 5;
    await run;

    expect(seen).toEqual(['webp']);
    expect(queue.settings?.encoderOptions).not.toBe(settings.encoderOptions);
  });

  it('ignores a duplicate drop of the same file', () => {
    const { queue } = testQueue();
    const file = makeFile('same.png', 500);
    expect(queue.add([file])).toHaveLength(1);
    expect(queue.add([file])).toHaveLength(0);
    expect(queue.items).toHaveLength(1);
  });

  it('removes, resets and clears', async () => {
    const { queue } = testQueue();
    queue.add([makeFile('a.png', 100), makeFile('b.png', 100)]);
    await queue.start(anySettings());
    expect(queue.progress.done).toBe(2);

    queue.reset();
    expect(queue.items.every((item) => item.status === 'pending')).toBe(true);
    expect(queue.items.every((item) => item.outFile === undefined)).toBe(true);

    const first = queue.items[0];
    if (first) queue.remove(first.id);
    expect(queue.items).toHaveLength(1);

    queue.clear();
    expect(queue.items).toHaveLength(0);
    expect(queue.progress.total).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Zip                                                                         */
/* -------------------------------------------------------------------------- */

describe('zip export', () => {
  it('archives only finished items', async () => {
    const items: BatchItem[] = [
      doneItem('a.png', 'a.jpg', bytes('AAA')),
      { ...doneItem('b.png', 'b.jpg', bytes('BBB')), status: 'pending', outFile: undefined },
    ];
    expect(zippableItems(items)).toHaveLength(1);

    const blob = await exportZip(items);
    expect(blob.type).toBe('application/zip');
    expect(blob.size).toBeGreaterThan(0);
  });

  it('keeps the source folder and the output filename', () => {
    const used = new Set<string>();
    expect(zipEntryPath(doneItem('holiday/2024/beach.png', 'beach.jpg', bytes('x')), used)).toBe(
      'holiday/2024/beach.jpg',
    );
    // A second file that collapses to the same path gets suffixed.
    expect(zipEntryPath(doneItem('other/beach.png', 'beach.jpg', bytes('x')), used)).toBe(
      'other/beach.jpg',
    );
    expect(zipEntryPath(doneItem('holiday/2024/beach.png', 'beach.jpg', bytes('x')), used)).toBe(
      'holiday/2024/beach (2).jpg',
    );
  });

  it('reports progress and finishes at 1', async () => {
    const seen: number[] = [];
    await exportZip([doneItem('a.png', 'a.jpg', bytes('hello'))], {
      onProgress: (fraction) => seen.push(fraction),
    });
    expect(seen.at(-1)).toBe(1);
  });

  it('rejects with an AbortError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      exportZip([doneItem('a.png', 'a.jpg', bytes('hello'))], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('produces a valid empty archive', async () => {
    const blob = await exportZip([]);
    // Empty zip: end-of-central-directory record only.
    expect(blob.size).toBe(22);
  });
});

/* -------------------------------------------------------------------------- */
/* Thumbnails                                                                  */
/* -------------------------------------------------------------------------- */

describe('thumbnail cache', () => {
  it('degrades to no thumbnail when the platform cannot decode', async () => {
    const cache = createThumbnailCache();
    // node has no createImageBitmap: the cache must resolve, not throw.
    await expect(cache.get('a', makeFile('a.png', 10))).resolves.toBeUndefined();
    expect(cache.peek('a')).toBeUndefined();
    cache.delete('a');
    cache.clear();
  });
});
