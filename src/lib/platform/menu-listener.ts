/**
 * Listener for the native macOS menu bar's click events.
 *
 * `src-tauri/src/menu.rs` builds the App/File/View/Help menu bar and, for
 * every custom item, emits one event — `About Pinch` and `Quit` are
 * `PredefinedMenuItem`s AppKit handles natively and never reach here. The two
 * files must agree on this shape, reproduced in both places on purpose:
 *
 *   event:   "pinch://menu"
 *   payload: { action: "open" }
 *          | { action: "close-tab" }
 *          | { action: "settings" }
 *          | { action: "view", view: "editor" | "matrix" | "queue" }
 *          | { action: "github" }
 *
 * This file turns that payload into calls on a plain handler object, so
 * whoever composes {@link initMenuListener} never touches the wire format.
 * Handler shape — the contract `App.svelte` (via `../platform`'s
 * `initPlatform`) implements against:
 *
 *   {
 *     open(): void;
 *     closeTab(): void;
 *     settings(): void;
 *     view(v: string): void;
 *     github(): void;
 *   }
 *
 * Web-safe by construction: {@link initMenuListener} only ever reaches
 * `@tauri-apps/api/event` through a dynamic import gated on {@link isTauri},
 * so importing this module never pulls Tauri into the shared bundle.
 */

import { isTauri } from './index';

/** Event name `menu.rs` emits for every custom item click. */
const MENU_EVENT = 'pinch://menu';

/** Wire shape of {@link MENU_EVENT}'s payload; mirrors `menu.rs`'s `MenuAction`. */
type MenuActionPayload =
  | { action: 'open' }
  | { action: 'close-tab' }
  | { action: 'settings' }
  | { action: 'view'; view: string }
  | { action: 'github' };

/** Handlers {@link initMenuListener} dispatches to, one per menu item. */
export interface MenuHandlers {
  open(): void;
  closeTab(): void;
  settings(): void;
  view(v: string): void;
  github(): void;
}

/**
 * Subscribe to the native menu bar. Call once, on mount; call the returned
 * function on teardown.
 *
 * A no-op on the web — resolves immediately to a no-op unsubscribe, without
 * touching `@tauri-apps/*` at all — so nothing about the browser build
 * changes and a caller never needs an `isTauri()` check of its own.
 */
export async function initMenuListener(handlers: MenuHandlers): Promise<() => void> {
  if (!isTauri()) return () => {};

  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<MenuActionPayload>(MENU_EVENT, (event) => {
    dispatch(handlers, event.payload);
  });
  return unlisten;
}

function dispatch(handlers: MenuHandlers, payload: MenuActionPayload): void {
  switch (payload.action) {
    case 'open':
      handlers.open();
      break;
    case 'close-tab':
      handlers.closeTab();
      break;
    case 'settings':
      handlers.settings();
      break;
    case 'view':
      handlers.view(payload.view);
      break;
    case 'github':
      handlers.github();
      break;
  }
}
