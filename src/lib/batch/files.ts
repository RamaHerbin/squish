/**
 * Getting files *into* the batch.
 *
 * Three entry points, all normalising to {@link PickedFile} (a `File` plus the
 * path it should keep inside the exported zip):
 *
 * - `<input multiple>`            → {@link pickedFilesFromFileList}
 * - `<input webkitdirectory>`     → {@link pickedFilesFromFileList} (uses `webkitRelativePath`)
 * - drag-and-drop of folders      → {@link pickedFilesFromDataTransfer} (recurses `webkitGetAsEntry`)
 *
 * Framework-free and side-effect-free so it can be unit tested in node.
 */

import { mimeTypeFromFilename } from '../contracts';

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** A picked file plus the path it keeps inside the batch. */
export interface PickedFile {
  file: File;
  /**
   * Relative path with forward slashes, e.g. `holiday/2024/beach.jpg`.
   * A plain filename for files that did not come from a folder.
   */
  path: string;
}

export interface CollectOptions {
  /** Hard ceiling on collected files, so a dropped `node_modules` cannot hang the tab. */
  maxFiles?: number;
  /** Hard ceiling on directory recursion depth. */
  maxDepth?: number;
  /** Keep non-image files instead of skipping them. Off by default. */
  includeNonImages?: boolean;
  /** Abort a long folder traversal. */
  signal?: AbortSignal;
}

export const DEFAULT_MAX_FILES = 5000;
export const DEFAULT_MAX_DEPTH = 16;

/** Directory/file names never worth walking into. */
const IGNORED_NAMES = new Set(['__MACOSX', '.DS_Store', 'Thumbs.db', 'desktop.ini']);

/* -------------------------------------------------------------------------- */
/* Path helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Last path segment. `a/b/c.png` → `c.png`. */
export function basename(path: string): string {
  const normalised = path.replace(/\\/g, '/');
  const index = normalised.lastIndexOf('/');
  return index === -1 ? normalised : normalised.slice(index + 1);
}

/** Everything before the last segment, `''` when there is none. */
export function dirname(path: string): string {
  const normalised = path.replace(/\\/g, '/');
  const index = normalised.lastIndexOf('/');
  return index === -1 ? '' : normalised.slice(0, index);
}

/** Join with a single separator, tolerating empty parts. */
export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

/**
 * Make a path safe to write into a zip: forward slashes, no leading slash, no
 * `.`/`..` segments, no drive letters. A malicious archive path is the classic
 * zip-slip vector and costs nothing to close off here.
 */
export function sanitizeZipPath(path: string): string {
  const segments = path
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:/, '')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
  return segments.join('/');
}

/** The path a `File` already knows about: folder-picker path, else its name. */
export function relativePathOf(file: File): string {
  const relative = file.webkitRelativePath;
  return relative && relative.length > 0 ? relative : file.name;
}

/* -------------------------------------------------------------------------- */
/* Filtering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Permissive image check: trust an `image/*` MIME type, otherwise fall back to
 * the extension table in contracts. Deliberately lenient — a false positive
 * becomes a per-item decode error, a false negative silently loses a file.
 */
export function looksLikeImage(file: File, path = file.name): boolean {
  if (file.type.startsWith('image/')) return true;
  return mimeTypeFromFilename(path) !== '';
}

function isIgnoredName(name: string): boolean {
  return IGNORED_NAMES.has(name) || name.startsWith('.');
}

/* -------------------------------------------------------------------------- */
/* FileList / File[]                                                           */
/* -------------------------------------------------------------------------- */

/** Normalise a `FileList` (or array) to picked files, honouring `webkitRelativePath`. */
export function pickedFilesFromFileList(
  files: FileList | readonly File[],
  options: CollectOptions = {},
): PickedFile[] {
  const max = options.maxFiles ?? DEFAULT_MAX_FILES;
  const picked: PickedFile[] = [];

  for (let index = 0; index < files.length; index++) {
    if (picked.length >= max) break;
    const file = files[index];
    if (!file) continue;
    const path = sanitizeZipPath(relativePathOf(file)) || file.name;
    if (isIgnoredName(basename(path))) continue;
    if (!options.includeNonImages && !looksLikeImage(file, path)) continue;
    picked.push({ file, path });
  }

  return picked;
}

/* -------------------------------------------------------------------------- */
/* Drag and drop                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Everything we must read from a `DataTransfer` *synchronously*.
 *
 * `DataTransfer.items` is neutered as soon as the drop handler yields, so the
 * entries have to be grabbed before the first `await`. {@link
 * pickedFilesFromDataTransfer} does that for you; this is exported for callers
 * that need to snapshot in an event handler and process later.
 */
export interface DropSnapshot {
  entries: FileSystemEntry[];
  files: File[];
}

export function snapshotDataTransfer(transfer: DataTransfer | null): DropSnapshot {
  const entries: FileSystemEntry[] = [];
  const files: File[] = [];
  if (!transfer) return { entries, files };

  const items = transfer.items as DataTransferItemList | undefined;
  if (items) {
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (!item || item.kind !== 'file') continue;
      const entry =
        typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
      if (entry) {
        entries.push(entry);
        continue;
      }
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }

  if (entries.length === 0) {
    const list = transfer.files as FileList | undefined;
    if (list) {
      for (let index = 0; index < list.length; index++) {
        const file = list[index];
        if (file) files.push(file);
      }
    }
  }

  return { entries, files };
}

/**
 * Collect every file in a drop, walking dropped folders recursively.
 *
 * Call this *directly inside* the `drop` handler — it snapshots the transfer
 * before doing any async work.
 */
export async function pickedFilesFromDataTransfer(
  transfer: DataTransfer | null,
  options: CollectOptions = {},
): Promise<PickedFile[]> {
  return pickedFilesFromSnapshot(snapshotDataTransfer(transfer), options);
}

export async function pickedFilesFromSnapshot(
  snapshot: DropSnapshot,
  options: CollectOptions = {},
): Promise<PickedFile[]> {
  const max = options.maxFiles ?? DEFAULT_MAX_FILES;
  const picked = pickedFilesFromFileList(snapshot.files, options);

  for (const entry of snapshot.entries) {
    if (picked.length >= max) break;
    await walkEntry(entry, '', picked, options, 0);
  }

  return picked;
}

async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: PickedFile[],
  options: CollectOptions,
  depth: number,
): Promise<void> {
  const max = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (out.length >= max || depth > maxDepth) return;
  if (options.signal?.aborted) return;
  if (isIgnoredName(entry.name)) return;

  if (entry.isFile) {
    const file = await fileOfEntry(entry as FileSystemFileEntry).catch(() => undefined);
    if (!file) return;
    const path = sanitizeZipPath(joinPath(prefix, entry.name)) || file.name;
    if (!options.includeNonImages && !looksLikeImage(file, path)) return;
    out.push({ file, path });
    return;
  }

  if (!entry.isDirectory) return;

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const childPrefix = joinPath(prefix, entry.name);

  // readEntries() returns at most ~100 entries per call; keep reading until it
  // hands back an empty batch.
  for (;;) {
    const batch = await readEntriesBatch(reader).catch(() => [] as FileSystemEntry[]);
    if (batch.length === 0) return;
    for (const child of batch) {
      if (out.length >= max) return;
      await walkEntry(child, childPrefix, out, options, depth + 1);
    }
  }
}

function readEntriesBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(
      (entries) => resolve(entries),
      (error) => reject(error),
    );
  });
}

function fileOfEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(
      (file) => resolve(file),
      (error) => reject(error),
    );
  });
}
