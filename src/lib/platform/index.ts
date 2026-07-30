/**
 * Platform seam — the one place that knows whether Pinch is running as a web
 * app or as the macOS (Tauri) app.
 *
 * Two rules govern this directory:
 *
 * 1. **Nothing here may statically import `@tauri-apps/*`.** Every native call
 *    lives in `./tauri.ts`, which is only ever reached through
 *    `await import('./tauri')` behind {@link isTauri}. A static import would
 *    pull the Tauri runtime into the shared web bundle, where
 *    `window.__TAURI_INTERNALS__` does not exist and the module throws on
 *    first use.
 * 2. **The web path must behave exactly as it did before this seam existed.**
 *    Every exported function short-circuits to the previous inline
 *    implementation when {@link isTauri} is false, synchronously — `saveBlob`
 *    never awaits before clicking the anchor, so the download still happens
 *    inside the user's gesture.
 *
 * The pure helpers (name sanitisation, extension/MIME mapping, save filters)
 * live here rather than in `./tauri.ts` so they are testable in node without
 * a Tauri import anywhere in the graph.
 */

import { mimeTypeFromFilename, type ImageMimeType } from '../contracts';

/* -------------------------------------------------------------------------- */
/* Detection                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * True when running inside the Tauri webview.
 *
 * Zero-import check, because the Tauri API's own `isTauri()` would require
 * importing `@tauri-apps/api/core` into shared code. Both globals below are
 * injected by tauri core before any application JavaScript runs:
 *
 * - `globalThis.isTauri` — what `@tauri-apps/api`'s `isTauri()` reads
 *   (node_modules/@tauri-apps/api/core.js: `!!(globalThis || window).isTauri`)
 * - `window.__TAURI_INTERNALS__` — the IPC bridge itself
 *
 * `window.__TAURI__` is deliberately not tested: `withGlobalTauri` is false in
 * tauri.conf.json, so that global does not exist.
 *
 * Safe in a worker and safe under SSR/vitest node: both reads are guarded.
 */
export function isTauri(): boolean {
  const global = globalThis as { isTauri?: unknown; __TAURI_INTERNALS__?: unknown };
  return global.isTauri === true || global.__TAURI_INTERNALS__ !== undefined;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Last path segment. `/Users/x/Desktop/a.heic` → `a.heic`. */
export function basenameOf(path: string): string {
  const normalised = path.replace(/\\/g, '/');
  const index = normalised.lastIndexOf('/');
  return index === -1 ? normalised : normalised.slice(index + 1);
}

/**
 * Lower-case extension without the dot, `''` when there is none.
 * A leading dot is a hidden file, not an extension: `.gitignore` → `''`.
 */
export function extensionOf(name: string): string {
  const base = basenameOf(name);
  const match = /.\.([A-Za-z0-9]+)$/.exec(base);
  return match?.[1]?.toLowerCase() ?? '';
}

/** Longest name any mainstream filesystem accepts for a single component. */
const MAX_NAME_LENGTH = 255;

/**
 * Make a suggested filename safe to hand to a native save dialog.
 *
 * A `defaultPath` containing `/` would be read as a directory, and `:` is the
 * legacy path separator macOS still hides from users in Finder. Control
 * characters are stripped outright.
 *
 * Only the native path uses this. The web anchor keeps passing the raw name to
 * the `download` attribute, exactly as before, because browsers already apply
 * their own (different) sanitisation and matching theirs is not worth a
 * behaviour change.
 */
export function sanitizeSuggestedName(name: string, fallback = 'image'): string {
  const cleaned = basenameOf(name)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/:/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned === '' || cleaned === '.' || cleaned === '..') return fallback;
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;

  // Truncate the stem, never the extension — a dialog that saves `photo.av`
  // produces a file nothing can open.
  const ext = extensionOf(cleaned);
  if (ext === '') return cleaned.slice(0, MAX_NAME_LENGTH);
  const stem = cleaned.slice(0, cleaned.length - ext.length - 1);
  return `${stem.slice(0, MAX_NAME_LENGTH - ext.length - 1)}.${ext}`;
}

/** One entry of a native save dialog's format filter. */
export interface SaveFilter {
  name: string;
  extensions: string[];
}

/** Human labels for the extensions Pinch actually writes. */
const FILTER_LABELS: Readonly<Record<string, string>> = {
  avif: 'AVIF',
  bmp: 'BMP',
  gif: 'GIF',
  heic: 'HEIC',
  heif: 'HEIF',
  jpe: 'JPEG',
  jpeg: 'JPEG',
  jpg: 'JPEG',
  json: 'JSON',
  jxl: 'JPEG XL',
  pdf: 'PDF',
  png: 'PNG',
  qoi: 'QOI',
  svg: 'SVG',
  tif: 'TIFF',
  tiff: 'TIFF',
  webp: 'WebP',
  zip: 'ZIP archive',
};

/** Extensions that belong to the same format and should be offered together. */
const FILTER_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  jpe: ['jpg', 'jpeg'],
  jpeg: ['jpg', 'jpeg'],
  jpg: ['jpg', 'jpeg'],
  tif: ['tif', 'tiff'],
  tiff: ['tif', 'tiff'],
};

/**
 * Save-dialog filters derived from a suggested filename.
 * Empty when the name has no extension — an unfiltered dialog beats a filter
 * that hides every file in the folder.
 */
export function saveFiltersFor(name: string): SaveFilter[] {
  const ext = extensionOf(name);
  if (ext === '') return [];
  const family = FILTER_FAMILIES[ext] ?? [ext];
  return [{ name: FILTER_LABELS[ext] ?? ext.toUpperCase(), extensions: [...family] }];
}

/**
 * MIME type for a path, by extension.
 *
 * Native "Open With" hands us a path and nothing else, so the type has to come
 * from the name. Same table the web intake uses, so a file opened from Finder
 * and the same file dropped on the window produce identical `File` objects.
 * The decode chain sniffs magic numbers anyway and overrides this when they
 * disagree.
 */
export function mimeTypeForPath(path: string): ImageMimeType | '' {
  return mimeTypeFromFilename(basenameOf(path));
}

/* -------------------------------------------------------------------------- */
/* Lazy native module                                                          */
/* -------------------------------------------------------------------------- */

type TauriModule = typeof import('./tauri');

let tauriModule: Promise<TauriModule> | undefined;

/**
 * The only route to `./tauri.ts`. Memoised so repeated saves do not re-enter
 * the module graph, and never called on the web.
 */
function loadTauri(): Promise<TauriModule> {
  tauriModule ??= import('./tauri');
  return tauriModule;
}

/* -------------------------------------------------------------------------- */
/* Saving                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What happened to a save request.
 *
 * The web can only ever report `'saved'`: once the anchor is clicked the
 * browser owns the rest and never reports back. `'cancelled'` is the native
 * "user dismissed the save panel".
 */
export type SaveOutcome = 'saved' | 'cancelled';

/**
 * Write a blob to disk.
 *
 * - **Web** — throwaway object URL + `<a download>`, the pattern this app has
 *   always used. Synchronous up to the click, so it stays inside the user
 *   gesture that triggered it.
 * - **macOS** — native save panel, then a real file write.
 *
 * Rejects only on a native write failure; the web path cannot fail.
 */
export async function saveBlob(suggestedName: string, blob: Blob): Promise<SaveOutcome> {
  if (isTauri()) {
    const tauri = await loadTauri();
    return tauri.saveBlob(suggestedName, blob);
  }
  return downloadViaAnchor(suggestedName, blob);
}

/**
 * The web implementation, verbatim from the two call sites it replaces
 * (`EditorView`'s download pill and `batch/zip.ts`'s `downloadBlob`).
 */
function downloadViaAnchor(suggestedName: string, blob: Blob): SaveOutcome {
  if (typeof document === 'undefined') return 'cancelled';
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = suggestedName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately races the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'saved';
}

/* -------------------------------------------------------------------------- */
/* External links                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Open a URL outside the app.
 *
 * On the web this is a plain new tab. Under Tauri a normal anchor would
 * navigate the *application window* to the URL with no way back, so the URL
 * goes to the system browser instead. Only `https:` is permitted by the
 * capability file, so anything else is refused before the IPC call.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const tauri = await loadTauri();
    await tauri.openExternal(url);
    return;
  }
  if (typeof window === 'undefined') return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * `onclick` handler for an anchor that points outside the app.
 *
 * On the web it does nothing at all: no `preventDefault`, so the browser
 * follows the `href` exactly as it did before. Under Tauri it cancels the
 * navigation and hands the URL to the system browser.
 *
 * ```svelte
 * <a href="https://example.com" target="_blank" rel="noopener noreferrer" onclick={openExternalLink}>
 * ```
 */
export function openExternalLink(event: MouseEvent): void {
  if (!isTauri()) return;
  const anchor = event.currentTarget as HTMLAnchorElement | null;
  const href = anchor?.href;
  if (!href) return;
  event.preventDefault();
  void openExternal(href);
}

/* -------------------------------------------------------------------------- */
/* Start-up                                                                    */
/* -------------------------------------------------------------------------- */

export interface PlatformInit {
  /**
   * Files handed to the app by the operating system: Finder "Open With", a
   * drop on the Dock icon, `open -a Pinch photo.png`, or a second launch.
   *
   * Additive batches, same shape as a drop on the window. Called any number of
   * times over the app's life, including once at start-up with whatever the
   * cold launch was carrying.
   */
  onFiles: (files: File[]) => void;
  /** Human-readable failure, e.g. a file the app was not allowed to read. */
  onError?: (message: string) => void;
}

/**
 * Wire the app to its host. Call once, on mount, and call the returned
 * function on teardown.
 *
 * A no-op on the web (returns immediately, subscribes to nothing), so nothing
 * about the browser build changes.
 */
export function initPlatform(init: PlatformInit): () => void {
  if (!isTauri()) return () => {};

  let disposed = false;
  let unlisten: (() => void) | undefined;

  void (async () => {
    try {
      const tauri = await loadTauri();
      const stop = await tauri.onOpenedFiles(init.onFiles, init.onError);
      if (disposed) stop();
      else unlisten = stop;
    } catch (error) {
      init.onError?.(messageOf(error));
    }
  })();

  return () => {
    disposed = true;
    unlisten?.();
    unlisten = undefined;
  };
}

/** Best-effort human text for anything thrown across the IPC boundary. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Something went wrong.';
}
