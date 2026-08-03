/**
 * The app version, in one place.
 *
 * `package.json` is the source of truth, and nobody edits it by hand either —
 * release-please bumps it in the release pull request. Everything else derives:
 *
 * - this constant, from the `define` block in `vite.config.ts`
 * - `src-tauri/tauri.conf.json`, whose `version` is the path `../package.json`
 *   (Tauri resolves it at build time, and that value is what the macOS "About
 *   Pinch" panel reports — it reads the config, not the crate)
 * - `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and
 *   `.release-please-manifest.json`, all rewritten in that same pull request
 *   (see `release-please-config.json`)
 *
 * So no component should ever spell a version out. `version.test.ts` fails the
 * suite if any of those surfaces drifts.
 */
export const APP_VERSION: string = __APP_VERSION__;

/** `v0.2.0` — the tag form, and how the UI shows it. */
export const APP_VERSION_TAG = `v${APP_VERSION}`;
