import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { APP_VERSION, APP_VERSION_TAG } from './version';

/**
 * The version lives in `package.json` and nowhere else a human edits. These
 * tests are the enforcement: they run in CI on every push and PR via
 * `npm test`, so a surface that drifts fails the suite instead of shipping a
 * build that reports the wrong number.
 *
 * Deliberately reads the files off disk rather than importing them, so it
 * checks what is committed rather than what a bundler resolved.
 */

const repoFile = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8');

const packageVersion = (JSON.parse(repoFile('package.json')) as { version: string }).version;

describe('app version', () => {
  it('is a bare semver triple', () => {
    // No `v` prefix, no pre-release suffix: the tag form adds the `v`, and
    // Tauri's config parser rejects anything that is not plain semver.
    expect(packageVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('reaches the UI as the build-time constant', () => {
    // Proves `vite.config.ts`'s `define` block is wired up. Without it this
    // import would be a ReferenceError, which is also a useful failure.
    expect(APP_VERSION).toBe(packageVersion);
    expect(APP_VERSION_TAG).toBe(`v${packageVersion}`);
  });

  it('matches the Cargo crate version', () => {
    // Only metadata now — the macOS About panel reads tauri.conf.json, not the
    // crate — but a stale crate version is confusing in cargo output, so
    // `scripts/release.mjs` keeps it in step and this keeps the script honest.
    const cargoToml = repoFile('src-tauri/Cargo.toml');
    const pkg = cargoToml.split(/^\[/m).find((section) => section.startsWith('package]'));
    expect(pkg, 'src-tauri/Cargo.toml has no [package] section').toBeDefined();
    const version = /^version\s*=\s*"([^"]+)"/m.exec(pkg ?? '')?.[1];
    expect(version).toBe(packageVersion);
  });

  it('keeps Tauri pointed at package.json instead of restating the number', () => {
    // Tauri resolves a path here (tauri-utils' PackageVersion visitor), and
    // that resolved value is what the bundle, the DMG filename and the macOS
    // About panel all report. Replacing it with a literal would silently
    // reintroduce the copy this test exists to prevent.
    const config = JSON.parse(repoFile('src-tauri/tauri.conf.json')) as { version: string };
    expect(config.version).toBe('../package.json');
  });
});
