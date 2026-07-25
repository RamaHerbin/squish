/**
 * Zip export.
 *
 * Store mode (level 0) by default: the payload is already-compressed image
 * data, so deflating it burns CPU for ~0 gain. That also means `fflate`'s
 * synchronous `ZipPassThrough` is enough — no worker, no CSP surprises.
 *
 * Streaming, twice over: each output is read chunk-by-chunk from its `Blob`
 * (which, when staged, is a disk-backed OPFS file — the bytes never all sit in
 * memory at once), and the archive is accumulated as `Uint8Array` parts handed
 * straight to the final `Blob`.
 *
 * Folder structure survives: an item named `holiday/2024/beach.jpg` encoded to
 * WebP lands at `holiday/2024/beach.webp`.
 */

import { AsyncZipDeflate, Zip, ZipPassThrough } from 'fflate';

import {
  BATCH_ZIP_FILENAME,
  createAbortError,
  dedupeFilename,
  type BatchItem,
  type ZipExport,
  type ZipExportOptions,
} from '../contracts';
import { basename, dirname, sanitizeZipPath } from './files';

/**
 * The two entry streams we use. `ZipInputFile` (fflate's interface) omits
 * `push()`, which is the whole point of a streaming entry, so the concrete
 * union is what gets passed around.
 */
type ZipEntryStream = ZipPassThrough | AsyncZipDeflate;

/** Items that actually have bytes to archive. */
export function zippableItems(items: readonly BatchItem[]): BatchItem[] {
  return items.filter((item) => item.status === 'done' && item.outFile !== undefined);
}

/**
 * Path an item takes inside the archive: the source's folder plus the output's
 * filename. `used` is threaded through so two `photo.png` from different
 * folders that collapse to the same path get ` (2)` suffixes.
 */
export function zipEntryPath(item: BatchItem, used: Set<string>): string {
  const folder = dirname(item.name);
  const name = item.outFile?.name ?? basename(item.name);
  const raw = folder ? `${folder}/${basename(name)}` : basename(name);
  return dedupeFilename(sanitizeZipPath(raw) || basename(name), used);
}

/* -------------------------------------------------------------------------- */
/* Export                                                                      */
/* -------------------------------------------------------------------------- */

export const exportZip: ZipExport = async (items, options: ZipExportOptions = {}) => {
  const { level = 0, onProgress, signal } = options;
  throwIfAborted(signal);

  const entries = zippableItems(items);
  const totalBytes = entries.reduce((sum, item) => sum + (item.outFile?.size ?? 0), 0);
  onProgress?.(entries.length === 0 ? 1 : 0);

  const parts: Uint8Array[] = [];
  let failure: Error | undefined;
  const finished = deferred();
  // The rejection can land before anything awaits it (fflate reports errors from
  // its own callback), and an unhandled rejection would take the page down.
  finished.promise.catch(() => {});

  const archive = new Zip((error, chunk, final) => {
    if (error) {
      failure ??= error;
      finished.reject(error);
      return;
    }
    if (chunk && chunk.length > 0) parts.push(chunk);
    if (final) finished.resolve();
  });

  const used = new Set<string>();
  let bytesWritten = 0;

  try {
    for (const item of entries) {
      throwIfAborted(signal);
      const output = item.outFile;
      if (!output) continue;

      const path = zipEntryPath(item, used);
      const entry: ZipEntryStream =
        level === 0 ? new ZipPassThrough(path) : new AsyncZipDeflate(path, { level });
      entry.mtime = output.lastModified || Date.now();
      archive.add(entry);

      await pumpInto(entry, output, signal, (bytes) => {
        bytesWritten += bytes;
        if (totalBytes > 0) onProgress?.(Math.min(1, bytesWritten / totalBytes));
      });

      if (failure) throw failure;
    }

    archive.end();
    await finished.promise;
  } catch (error) {
    try {
      archive.terminate();
    } catch {
      /* already finished */
    }
    throw error;
  }

  if (failure) throw failure;
  onProgress?.(1);
  return new Blob(parts as BlobPart[], { type: 'application/zip' });
};

/**
 * Feed a blob into a zip entry one chunk at a time.
 *
 * fflate needs to know which chunk is the last, so a single chunk is always
 * held back — an empty file still gets one `push(final: true)`.
 */
async function pumpInto(
  entry: ZipEntryStream,
  blob: Blob,
  signal: AbortSignal | undefined,
  onBytes: (bytes: number) => void,
): Promise<void> {
  const push = (chunk: Uint8Array, final: boolean): void => entry.push(chunk, final);

  if (typeof blob.stream !== 'function') {
    const buffer = new Uint8Array(await blob.arrayBuffer());
    throwIfAborted(signal);
    push(buffer, true);
    onBytes(buffer.length);
    return;
  }

  const reader = blob.stream().getReader();
  let held: Uint8Array | undefined;

  try {
    for (;;) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      if (done) break;
      if (held) {
        push(held, false);
        onBytes(held.length);
      }
      held = value;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }

  if (held) {
    push(held, true);
    onBytes(held.length);
  } else {
    push(new Uint8Array(0), true);
  }
}

/* -------------------------------------------------------------------------- */
/* Download                                                                    */
/* -------------------------------------------------------------------------- */

/** Save a blob to disk via a throwaway object URL. */
export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately races the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Build the archive and save it as `squished.zip`. */
export async function downloadZip(
  items: readonly BatchItem[],
  options?: ZipExportOptions & { filename?: string },
): Promise<void> {
  const blob = await exportZip(items, options);
  downloadBlob(blob, options?.filename ?? BATCH_ZIP_FILENAME);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createAbortError();
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
