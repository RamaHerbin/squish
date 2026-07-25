/**
 * The native half of the platform seam. macOS only, loaded lazily.
 *
 * **Never import this module statically from shared code.** Every entry point
 * here assumes `window.__TAURI_INTERNALS__` exists; on the web the imports
 * below would be bundled into the main chunk and every call would throw. Go
 * through `./index.ts`, which reaches this file with `await import('./tauri')`
 * behind `isTauri()`.
 *
 * The `@tauri-apps/*` imports are themselves dynamic, one per function. That
 * is not redundant with the lazy module load: it keeps the dialog, fs and
 * opener plugins in separate chunks so opening a file never pays for the save
 * dialog's code, and it means a plugin missing from a future build breaks one
 * feature instead of the whole module.
 *
 * Capability reminder (src-tauri/capabilities/default.json): only
 * `dialog:allow-save`, `fs:allow-write-file` and `opener:allow-open-url`
 * scoped to `https://*` are granted. `open()`, `message()`, `ask()`,
 * `revealItemInDir()`, every fs *read*, and `http://` links are denied at
 * runtime, so nothing here may use them.
 *
 * Reading a file the OS opened therefore does not go through the fs plugin: a
 * read permission wide enough for anything Finder can hand over would mean
 * granting the webview most of `$HOME`. It goes through the `read_opened_file`
 * app command instead — app commands are not subject to the ACL, and that one
 * serves only the paths Rust itself emitted. See {@link READ_OPENED_FILE_COMMAND}.
 */

import {
  basenameOf,
  mimeTypeForPath,
  messageOf,
  sanitizeSuggestedName,
  saveFiltersFor,
  type SaveOutcome,
} from './index';

/* -------------------------------------------------------------------------- */
/* Saving                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Native save panel, then a real write.
 *
 * No `baseDir` is passed and none should be: the dialog plugin adds whatever
 * the user picked to the fs scope for the lifetime of the process, which is
 * what makes a destination outside Downloads and Desktop writable at all.
 */
export async function saveBlob(suggestedName: string, blob: Blob): Promise<SaveOutcome> {
  const defaultPath = sanitizeSuggestedName(suggestedName);
  const filters = saveFiltersFor(defaultPath);

  const { save } = await import('@tauri-apps/plugin-dialog');
  const path = await save(filters.length > 0 ? { defaultPath, filters } : { defaultPath });
  if (path === null) return 'cancelled';

  const { writeFile } = await import('@tauri-apps/plugin-fs');
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  return 'saved';
}

/* -------------------------------------------------------------------------- */
/* Files opened by macOS                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Event the Rust side emits for Finder "Open With", a drop on the Dock icon,
 * `open -a Pinch file.png`, and a second launch's argv.
 *
 * Payload is a non-empty array of absolute POSIX paths, each of which passed
 * `Path::is_file()` at emit time.
 */
const OPENED_FILES_EVENT = 'pinch://files-opened';

/**
 * Command that drains the Rust-side start-up buffer.
 *
 * macOS delivers the "opened" event before the webview has run a single line
 * of JavaScript, so a cold "Open With" is held in Rust until this is invoked.
 * It drains *through the same event*, so there is exactly one code path here.
 * Idempotent.
 */
const FRONTEND_READY_COMMAND = 'pinch_frontend_ready';

/**
 * Command that returns the bytes of a path the OS opened.
 *
 * Not `readFile()` from the fs plugin: no read permission is granted, and
 * granting one wide enough to cover "any file the user can pick in Finder"
 * would mean handing the webview most of `$HOME`. This command serves only
 * paths the Rust side already emitted through {@link OPENED_FILES_EVENT},
 * canonicalised before comparison, and returns raw bytes (an `ArrayBuffer` on
 * this side) rather than a JSON array of numbers, so a 40 MB HEIC does not
 * crawl through serialisation.
 *
 * Rejects with a string message when the path was never authorised or the read
 * fails.
 */
const READ_OPENED_FILE_COMMAND = 'read_opened_file';

/**
 * Subscribe to files handed over by the operating system.
 *
 * Order below is load-bearing: the listener must be attached before the
 * buffer is drained, or a cold launch loses its files.
 *
 * @returns an unsubscribe function.
 */
export async function onOpenedFiles(
  onFiles: (files: File[]) => void,
  onError?: (message: string) => void,
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');

  const unlisten = await listen<string[]>(OPENED_FILES_EVENT, (event) => {
    void (async () => {
      const { files, failed } = await filesFromPaths(event.payload);
      if (files.length > 0) onFiles(files);
      if (failed.length > 0) {
        onError?.(`Could not read: ${failed.map((entry) => entry.name).join(', ')}`);
      }
    })();
  });

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke(FRONTEND_READY_COMMAND);

  return unlisten;
}

interface ReadFailure {
  name: string;
  reason: string;
}

/**
 * Read absolute paths into `File` objects the rest of the app cannot tell
 * apart from a drop.
 *
 * Reads run in parallel; a path that cannot be read is reported and skipped
 * rather than failing the whole batch. That soft failure also covers the case
 * where {@link READ_OPENED_FILE_COMMAND} is missing from the Rust side
 * entirely — an unknown command rejects, and the app still launches.
 */
async function filesFromPaths(
  paths: readonly string[],
): Promise<{ files: File[]; failed: ReadFailure[] }> {
  const { invoke } = await import('@tauri-apps/api/core');

  const results = await Promise.all(
    paths.map(async (path): Promise<File | ReadFailure> => {
      const name = basenameOf(path);
      try {
        const raw = await invoke<IpcBytes>(READ_OPENED_FILE_COMMAND, { path });
        const type = mimeTypeForPath(path);
        // `lastModified` defaults to now. The metadata read that would give the
        // real mtime needs a permission we deliberately do not hold, and
        // nothing downstream treats it as more than a cache key.
        return new File([bytesOf(raw)], name, type === '' ? {} : { type });
      } catch (error) {
        return { name, reason: messageOf(error) };
      }
    }),
  );

  const files: File[] = [];
  const failed: ReadFailure[] = [];
  for (const result of results) {
    if (result instanceof File) files.push(result);
    else failed.push(result);
  }
  return { files, failed };
}

/** What a raw command response can arrive as. */
type IpcBytes = ArrayBuffer | Uint8Array<ArrayBuffer> | number[];

/**
 * The custom-protocol IPC decodes a raw response as an `ArrayBuffer`; the
 * `postMessage` fallback Tauri switches to when that protocol is blocked hands
 * back a plain number array instead. Both have to end up as bytes — passing the
 * array straight to `new File()` would stringify it.
 *
 * Nothing here copies the buffer: an image can be tens of megabytes.
 */
function bytesOf(raw: IpcBytes): Uint8Array<ArrayBuffer> {
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return Uint8Array.from(raw);
  return new Uint8Array(raw);
}

/* -------------------------------------------------------------------------- */
/* External links                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Hand a URL to the system browser.
 *
 * Only `https:` is allowed by the capability file, and letting anything else
 * reach the IPC call would just produce a denial in the console.
 */
export async function openExternal(url: string): Promise<void> {
  if (!url.startsWith('https://')) return;
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}
