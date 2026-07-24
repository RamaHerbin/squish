/**
 * Disk staging for batch artefacts, backed by the Origin Private File System.
 *
 * ## Why
 * A 300-file batch produces 300 encoded `Blob`s. Those live in the renderer's
 * heap until the user exports, and on a phone that is how the tab dies. Writing
 * each result to OPFS and handing back the `File` returned by
 * `FileSystemFileHandle.getFile()` keeps the bytes on disk: the `File` is a
 * lazy, disk-backed handle, so `URL.createObjectURL()`, `file.stream()` (zip
 * export) and per-item download all keep working while memory stays flat.
 *
 * ## What is *not* staged by default
 * Input files. A `File` that came from `<input>` or a drop is already a
 * disk-backed handle owned by the browser — copying it into OPFS would double
 * the disk traffic and stall `add()` on a big drop, for no memory win. Staging
 * inputs is available via `stageInputs` for the one case where it does pay:
 * guarding against the user moving or deleting the source files mid-run.
 *
 * ## Failure policy
 * Staging is an optimisation, never a correctness requirement. Every operation
 * degrades to "return the file you gave me" if OPFS is missing (Safari < 15.2,
 * some private modes), out of quota, or throws for any other reason.
 */

/** Where staged artefacts live inside the origin private file system. */
export const STAGE_ROOT_DIR = 'squish-batch';

/** Sessions older than this are swept on startup. */
export const STAGE_STALE_MS = 12 * 60 * 60 * 1000;

export interface StagedFileStore {
  /** `'opfs'` when bytes really land on disk, `'memory'` for the no-op fallback. */
  readonly kind: 'opfs' | 'memory';
  /** True once an OPFS operation has failed and the store fell back to pass-through. */
  readonly degraded: boolean;
  /**
   * Persist `file` under `key`, returning a file with the same name and type.
   * Returns the input unchanged if staging is unavailable.
   */
  stage(key: string, file: File): Promise<File>;
  /** Drop everything stored under `key`. Never throws. */
  release(key: string): Promise<void>;
  /** Drop the whole session directory. Never throws. */
  clear(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Capability probe                                                            */
/* -------------------------------------------------------------------------- */

export function isOpfsSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  const storage = navigator.storage as StorageManager | undefined;
  if (!storage || typeof storage.getDirectory !== 'function') return false;
  return typeof FileSystemFileHandle !== 'undefined';
}

/** OPFS when available, a pass-through store otherwise. */
export function createFileStage(namespace?: string): StagedFileStore {
  return isOpfsSupported() ? createOpfsStage(namespace) : createMemoryStage();
}

/** Pass-through store: hands every file straight back. */
export function createMemoryStage(): StagedFileStore {
  return {
    kind: 'memory',
    degraded: false,
    async stage(_key, file) {
      return file;
    },
    async release() {},
    async clear() {},
  };
}

/* -------------------------------------------------------------------------- */
/* OPFS implementation                                                         */
/* -------------------------------------------------------------------------- */

export function createSessionNamespace(): string {
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createOpfsStage(namespace = createSessionNamespace()): StagedFileStore {
  let directory: Promise<FileSystemDirectoryHandle> | undefined;
  let degraded = false;

  async function sessionDirectory(): Promise<FileSystemDirectoryHandle> {
    directory ??= (async () => {
      const root = await navigator.storage.getDirectory();
      const stageRoot = await root.getDirectoryHandle(STAGE_ROOT_DIR, { create: true });
      await sweepStaleSessions(stageRoot, namespace);
      return stageRoot.getDirectoryHandle(namespace, { create: true });
    })();
    return directory;
  }

  return {
    kind: 'opfs',
    get degraded() {
      return degraded;
    },

    async stage(key, file) {
      try {
        const session = await sessionDirectory();
        // One directory per key so the entry can keep the exact output filename
        // (`getFile()` reports the OPFS entry name) and `release()` is one call.
        const itemDir = await session.getDirectoryHandle(safeSegment(key), { create: true });
        const entryName = safeSegment(file.name) || 'output';
        const handle = await itemDir.getFileHandle(entryName, { create: true });

        const writable = await handle.createWritable();
        if (typeof file.stream === 'function') {
          await file.stream().pipeTo(writable);
        } else {
          await writable.write(file);
          await writable.close();
        }

        const staged = await handle.getFile();
        // Only re-wrap when sanitising changed the name; `new File([staged], …)`
        // references the same disk-backed blob rather than copying it.
        if (staged.name === file.name && staged.type === file.type) return staged;
        return new File([staged], file.name, {
          type: file.type,
          lastModified: file.lastModified,
        });
      } catch {
        degraded = true;
        return file;
      }
    },

    async release(key) {
      try {
        const session = await sessionDirectory();
        await session.removeEntry(safeSegment(key), { recursive: true });
      } catch {
        /* already gone, or OPFS unavailable — nothing to do */
      }
    },

    async clear() {
      const pending = directory;
      directory = undefined;
      if (!pending) return;
      try {
        await pending;
        const root = await navigator.storage.getDirectory();
        const stageRoot = await root.getDirectoryHandle(STAGE_ROOT_DIR, { create: true });
        await stageRoot.removeEntry(namespace, { recursive: true });
      } catch {
        /* best effort */
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Housekeeping                                                                */
/* -------------------------------------------------------------------------- */

/** Minimal shape of the async-iterable half of `FileSystemDirectoryHandle`. */
interface IterableDirectoryHandle {
  values?: () => AsyncIterable<{ kind: string; name: string }>;
}

/**
 * Delete leftovers from sessions that ended without a `clear()` (tab crash,
 * refresh mid-run). Only sessions whose encoded timestamp is older than
 * {@link STAGE_STALE_MS} are touched, so a second tab running right now is safe.
 */
async function sweepStaleSessions(
  stageRoot: FileSystemDirectoryHandle,
  current: string,
): Promise<void> {
  const iterable = stageRoot as unknown as IterableDirectoryHandle;
  if (typeof iterable.values !== 'function') return;

  try {
    const stale: string[] = [];
    for await (const entry of iterable.values()) {
      if (entry.kind !== 'directory' || entry.name === current) continue;
      const at = sessionTimestamp(entry.name);
      if (at === undefined || Date.now() - at > STAGE_STALE_MS) stale.push(entry.name);
    }
    for (const name of stale) {
      await stageRoot.removeEntry(name, { recursive: true }).catch(() => {});
    }
  } catch {
    /* enumeration unsupported or racing another tab — skip the sweep */
  }
}

function sessionTimestamp(name: string): number | undefined {
  const match = /^session-([0-9a-z]+)-/.exec(name);
  const encoded = match?.[1];
  if (encoded === undefined) return undefined;
  const value = Number.parseInt(encoded, 36);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Strip anything that cannot be a single OPFS entry name — path separators,
 * control characters and the Windows-reserved punctuation. Dots, digits and
 * spaces survive, so `my photo.2.jpg` keeps its extension.
 */
export function safeSegment(name: string): string {
  const cleaned = name
    .replace(/\p{Cc}/gu, '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180);
  return cleaned === '' ? '_' : cleaned;
}
