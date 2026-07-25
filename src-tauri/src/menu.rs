//! Native macOS menu bar for Pinch.
//!
//! Every custom item funnels through one event, whose payload is a small
//! tagged object the frontend switches on. `src/lib/platform/menu-listener.ts`
//! is the receiving end; the two files must agree on this shape, reproduced
//! in both places on purpose:
//!
//!   event:   "pinch://menu"
//!   payload: { action: "open" }
//!          | { action: "close-tab" }
//!          | { action: "settings" }
//!          | { action: "view", view: "editor" | "matrix" | "queue" }
//!          | { action: "github" }
//!
//! `About Pinch` and `Quit` are `PredefinedMenuItem`s: AppKit handles them
//! natively (the real about panel, the real quit) and neither one ever
//! reaches `on_menu_event`, so they have no entry in [`MenuAction`].

use serde::Serialize;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

/// Single event name for every menu action; the frontend tells them apart by
/// `payload.action`.
const MENU_EVENT: &str = "pinch://menu";

/// Label of the single window declared in `tauri.conf.json`. Duplicated from
/// `lib.rs` rather than imported: it is a literal, not shared state, and
/// this file is meant to be readable on its own.
const MAIN_WINDOW: &str = "main";

/// The three views the View menu can jump to. Names match the `AppView`
/// union in `src/lib/contracts/pinch.ts`; `home` and `settings` have no menu
/// entry, so they have no case here.
#[derive(Clone, Serialize)]
#[serde(rename_all = "lowercase")]
enum ViewTarget {
    Editor,
    Matrix,
    Queue,
}

/// Payload of [`MENU_EVENT`]. `#[serde(tag = "action", rename_all =
/// "kebab-case")]` is what turns each variant into exactly the shape the
/// frontend expects: `CloseTab` serialises to `{"action":"close-tab"}`,
/// `View { view: Editor }` to `{"action":"view","view":"editor"}`.
#[derive(Clone, Serialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
enum MenuAction {
    Open,
    CloseTab,
    Settings,
    View { view: ViewTarget },
    Github,
}

/// Wire the macOS menu bar into `builder`: attach it as the app-wide menu
/// and register the one handler that turns a click into [`MENU_EVENT`].
///
/// Called once from `lib.rs`, replacing the bare `builder` the fluent chain
/// used to start on: `menu::init(builder).plugin(...)` instead of
/// `builder.plugin(...)`.
pub fn init<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.menu(build).on_menu_event(|app, event| {
        if let Some(action) = action_for(event.id().as_ref()) {
            let _ = app.emit_to(MAIN_WINDOW, MENU_EVENT, action);
        }
    })
}

/// Map a clicked custom item's id to the payload it should emit. The
/// predefined items (about, quit) never reach this function at all; `None`
/// is a defensive fallback for an id this menu never actually hands out.
fn action_for(id: &str) -> Option<MenuAction> {
    Some(match id {
        "open" => MenuAction::Open,
        "close-tab" => MenuAction::CloseTab,
        "settings" => MenuAction::Settings,
        "view-editor" => MenuAction::View { view: ViewTarget::Editor },
        "view-matrix" => MenuAction::View { view: ViewTarget::Matrix },
        "view-queue" => MenuAction::View { view: ViewTarget::Queue },
        "github" => MenuAction::Github,
        _ => return None,
    })
}

/// Build the menu bar: App, File, View, Help, in that order. Runs once, from
/// `tauri::Builder::menu`, before the first window opens.
fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg_info = app.package_info();
    let about = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        pkg_info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "settings", "Settings...", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "open", "Open...", true, Some("CmdOrCtrl+O"))?,
            &MenuItem::with_id(app, "close-tab", "Close Tab", true, Some("CmdOrCtrl+W"))?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, "view-editor", "Editor", true, Some("CmdOrCtrl+1"))?,
            &MenuItem::with_id(app, "view-matrix", "Matrix", true, Some("CmdOrCtrl+2"))?,
            &MenuItem::with_id(app, "view-queue", "Queue", true, Some("CmdOrCtrl+3"))?,
        ],
    )?;

    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[&MenuItem::with_id(
            app,
            "github",
            "GitHub Repository",
            true,
            None::<&str>,
        )?],
    )?;

    Menu::with_items(app, &[&app_menu, &file_menu, &view_menu, &help_menu])
}
