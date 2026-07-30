//! Pinch, macOS shell.
//!
//! The web app is the whole product. This crate does three things and nothing
//! else: it opens one window pointed at the same bundle the browser gets, it
//! answers when macOS hands us files (Finder "Open With", drag onto the Dock
//! icon, `open -a Pinch photo.heic`), and it keeps a second launch from
//! becoming a second window.

mod menu;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Event delivered to the main webview carrying absolute paths macOS asked us
/// to open. Payload is a `string[]`, never empty when the event fires.
const FILES_OPENED_EVENT: &str = "pinch://files-opened";

/// Label of the single window declared in `tauri.conf.json`.
const MAIN_WINDOW: &str = "main";

/// Paths waiting for a webview that can receive them.
///
/// macOS delivers `RunEvent::Opened` while the process is still starting, long
/// before the webview has run a line of JavaScript, so a cold "Open With"
/// always arrives too early to be listened for. Those paths park here until
/// `pinch_frontend_ready` reports that a listener is attached. `ready` drops
/// back to false at the start of every navigation, so a reload (or Vite's HMR
/// full reload in dev) cannot swallow a file that lands mid-flight.
#[derive(Default)]
struct OpenedFiles {
    ready: bool,
    pending: Vec<String>,
    /// Canonicalised paths this app was explicitly asked to open. This is the
    /// whole read authority of the frontend: `read_opened_file` serves these
    /// and nothing else, so no fs read permission exists in the capability
    /// file at all.
    authorized: HashSet<PathBuf>,
}

#[derive(Default)]
struct OpenedFilesState(Mutex<OpenedFiles>);

/// A poisoned lock here would mean an earlier panic while holding it. The data
/// is a path list, so recovering it is strictly better than panicking again.
fn lock(state: &Mutex<OpenedFiles>) -> MutexGuard<'_, OpenedFiles> {
    state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Route freshly opened paths to the webview, or park them if it is not ready.
/// Every path that passes through here is recorded as readable by
/// [`read_opened_file`], canonicalised so a symlinked request still matches.
fn deliver<R: Runtime>(app: &AppHandle<R>, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let state = app.state::<OpenedFilesState>();
    let mut opened = lock(&state.0);
    for path in &paths {
        if let Ok(canonical) = std::fs::canonicalize(path) {
            opened.authorized.insert(canonical);
        }
    }
    if opened.ready {
        drop(opened);
        let _ = app.emit_to(MAIN_WINDOW, FILES_OPENED_EVENT, paths);
    } else {
        opened.pending.extend(paths);
    }
}

/// Bring the existing window forward. Called on every open request, because
/// the point of "Open With Pinch" is to end up looking at Pinch.
fn focus_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Accept either a plain path or a `file://` URL, and only if it names a file
/// that exists right now. Anything else is a flag, a stale path or a URL
/// scheme we do not handle, and is dropped silently.
fn normalise(arg: &str) -> Option<String> {
    let path = if arg.starts_with("file://") {
        tauri::Url::parse(arg).ok()?.to_file_path().ok()?
    } else {
        PathBuf::from(arg)
    };
    path.is_file().then(|| path.to_string_lossy().into_owned())
}

/// Pull openable files out of a command line, skipping argv[0] and flags.
fn paths_from_argv(argv: &[String]) -> Vec<String> {
    argv.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter_map(|arg| normalise(arg))
        .collect()
}

/// Called by the frontend once it has subscribed to [`FILES_OPENED_EVENT`].
/// Flushes whatever queued up during startup and marks the webview live so
/// later opens go straight through.
#[tauri::command]
fn pinch_frontend_ready(app: AppHandle, state: tauri::State<'_, OpenedFilesState>) {
    let pending = {
        let mut opened = lock(&state.0);
        opened.ready = true;
        std::mem::take(&mut opened.pending)
    };
    if !pending.is_empty() {
        let _ = app.emit_to(MAIN_WINDOW, FILES_OPENED_EVENT, pending);
    }
}

/// Mirrors `MAX_FILE_BYTES` in `src/lib/contracts/image.ts` — the "MAX 50 MB
/// / FILE" contract the UI advertises. Enforced here too, so an oversized file
/// is rejected from metadata alone instead of being read into memory first.
const MAX_READ_BYTES: u64 = 50 * 1024 * 1024;

/// Mirrors `PDF_MAX_FILE_BYTES` in `src/lib/contracts/pdf.ts`;
/// `src/lib/contracts/pdf.test.ts` binds the two.
const MAX_PDF_READ_BYTES: u64 = 150 * 1024 * 1024;

/// Per-file read ceiling for a path, by extension: PDFs get the larger
/// [`MAX_PDF_READ_BYTES`], everything else the image-oriented [`MAX_READ_BYTES`].
fn max_read_bytes(path: &std::path::Path) -> u64 {
    let is_pdf = path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"));
    if is_pdf {
        MAX_PDF_READ_BYTES
    } else {
        MAX_READ_BYTES
    }
}

/// Canonicalise a requested path and check it against the opened-files
/// whitelist. Symlinks and `/tmp` vs `/private/tmp` cannot dodge or fake
/// authorisation because both sides of the comparison are canonical.
fn authorized_path(
    state: &tauri::State<'_, OpenedFilesState>,
    path: &str,
) -> Result<PathBuf, String> {
    let requested = std::fs::canonicalize(PathBuf::from(path))
        .map_err(|error| format!("cannot resolve {path}: {error}"))?;
    if !lock(&state.0).authorized.contains(&requested) {
        return Err(format!("not a file this app was asked to open: {path}"));
    }
    Ok(requested)
}

/// Hand the bytes of an opened file to the frontend.
///
/// Serves only whitelisted paths (see [`authorized_path`]), refuses anything
/// over [`max_read_bytes`] before reading a single byte, and returns raw bytes
/// ([`tauri::ipc::Response`]) so a 40 MB HEIC does not crawl through JSON.
/// `async` keeps the read off the IPC thread.
#[tauri::command]
async fn read_opened_file(
    path: String,
    state: tauri::State<'_, OpenedFilesState>,
) -> Result<tauri::ipc::Response, String> {
    let requested = authorized_path(&state, &path)?;
    let meta = std::fs::metadata(&requested)
        .map_err(|error| format!("cannot stat {path}: {error}"))?;
    let limit = max_read_bytes(&requested);
    if meta.len() > limit {
        return Err(format!(
            "{path} is over the {} MB per-file limit",
            limit / (1024 * 1024)
        ));
    }
    let bytes =
        std::fs::read(&requested).map_err(|error| format!("cannot read {path}: {error}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Modification time of an opened file, in milliseconds since the epoch.
///
/// The frontend stamps it onto the constructed `File` so the tab store's
/// (name, size, lastModified) dedupe recognises a re-opened path instead of
/// spawning a duplicate tab. Same whitelist as [`read_opened_file`].
#[tauri::command]
fn opened_file_mtime(
    path: String,
    state: tauri::State<'_, OpenedFilesState>,
) -> Result<u64, String> {
    let requested = authorized_path(&state, &path)?;
    let modified = std::fs::metadata(&requested)
        .and_then(|meta| meta.modified())
        .map_err(|error| format!("cannot stat {path}: {error}"))?;
    let millis = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("mtime before the epoch: {error}"))?
        .as_millis();
    Ok(u64::try_from(millis).unwrap_or(u64::MAX))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Must be registered before anything else: the plugin decides whether this
    // process lives or hands its argv to the one already running.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            focus_main(app);
            deliver(app, paths_from_argv(&argv));
        }));
    }

    menu::init(builder)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(OpenedFilesState::default())
        .invoke_handler(tauri::generate_handler![
            pinch_frontend_ready,
            read_opened_file,
            opened_file_mtime
        ])
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                let state = webview.state::<OpenedFilesState>();
                lock(&state.0).ready = false;
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Pinch application")
        .run(|_app, _event| {
            // Finder "Open With", a drop on the Dock icon and `open -a Pinch
            // file.png` all land here. On a cold launch this fires before the
            // webview exists, which is exactly what `OpenedFiles` is for.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &_event {
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .filter(|path| path.is_file())
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect();
                focus_main(_app);
                deliver(_app, paths);
            }
        });
}
