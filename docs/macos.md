# Pinch for macOS

Pinch is a web app first. The macOS app is the same frontend, the same Svelte code, the
same WebAssembly codecs, running inside a native window instead of a browser tab. Nothing
about the compression pipeline changes: it is the identical `dist/` build the website
ships, loaded by [Tauri 2](https://v2.tauri.app/) into a WKWebView, which is the same
engine Safari uses on macOS.

What Tauri adds is the shell around that webview: a native window with its own title bar
and icon, a save dialog instead of a browser download, and the ability to register Pinch
as something Finder can open images with. What Tauri does not add is a second
implementation of anything. There is one codebase, one set of codecs, and one behaviour
for compressing an image, whether you reach it through a URL or through the Dock.

## Building locally

You need Rust and Xcode's command line tools installed. From the repo root:

```sh
npm run tauri:build
```

This runs the same `npm run build` the web app uses to produce `dist/`, then hands that
build to Tauri's bundler. On a machine with only the Apple Silicon Rust target installed
(the default for a Mac that has never targeted Intel), the result is an Apple
Silicon-only build:

- The app: `src-tauri/target/release/bundle/macos/Pinch.app`
- The disk image: `src-tauri/target/release/bundle/dmg/Pinch_0.1.0_aarch64.dmg`

For a build that also runs on Intel Macs, add the second target once and pass
`--target universal-apple-darwin`:

```sh
rustup target add x86_64-apple-darwin
npm run tauri:build -- --target universal-apple-darwin
```

That produces a single universal binary instead of two separate ones, at the cost of a
noticeably longer compile.

For day-to-day development, `npm run tauri:dev` opens the native window against the Vite
dev server, with hot reload working exactly as it does in a browser tab.

## Opening it the first time

The build above is not signed with an Apple Developer ID, so macOS Gatekeeper will not
let you open it with a plain double-click. It is not damaged, it is just unrecognised.
Either of these gets past that, once:

1. **Right-click (or Control-click) the app and choose Open**, then confirm in the dialog
   that appears. This only needs to happen the first time; afterward the app opens
   normally.
2. Or, if you already tried the plain double-click and got the "cannot be opened" alert,
   open **System Settings → Privacy & Security**, scroll to the note about Pinch being
   blocked, and click **Open Anyway**.

Neither step is a Pinch-specific quirk. It is what any unsigned, unnotarised Mac app asks
for.

## What differs from the web version

Everything below is a consequence of running as a native app rather than a change to how
Pinch compresses images.

- **Saving.** The web app downloads through the browser's own download UI. The macOS app
  opens a native save panel, and you choose the exact destination and filename yourself;
  nothing lands in a default Downloads folder unless you point it there.
- **File associations.** Finder can open image files with Pinch directly ("Open With
  Pinch", drag-and-drop onto the Dock icon, or a second `open -a Pinch photo.png` from the
  command line), and Pinch registers itself as a viewer for the common formats it reads.
  It does not claim to be your default image opener; that choice stays with Finder or with
  whichever app you had before.
- **HEIC decoding.** iPhone photos already open in the web app for anyone on Safari,
  because Safari decodes HEIC natively and only falls back to the bundled libheif
  WebAssembly decoder elsewhere. The macOS app uses that same native-decode-first path
  every time, since its webview is Safari's engine. The wasm fallback is still there; it
  just has less to do.
- **No service worker, and that is fine.** Service workers are how the web app stays
  installable and works offline, and WKWebView does not run them on Tauri's custom
  `tauri://` scheme, so that code path is inactive in the native build. It is not needed
  there: the native app already ships its assets inside the bundle, so "offline" is just
  how a native app behaves by default, not a feature it has to opt into.

## Notarisation: not set up yet

The build above is unsigned, which is fine for running it on the machine that built it
but is not something to hand to someone else without the Gatekeeper workaround above. Two
separate things would need to happen before an outside download could open with a plain
double-click:

1. **Code signing** with an Apple Developer ID certificate, via `codesign`, so macOS can
   verify the binary has not been tampered with since it was built.
2. **Notarisation**, submitting the signed build to Apple with `xcrun notarytool` and
   stapling the resulting ticket to the app, so Gatekeeper can confirm Apple scanned it.

Both need an active Apple Developer Program membership and are outside the scope of this
round of work. Until that is set up, distribute the app with the Gatekeeper workaround
documented above, or build it yourself from source.
