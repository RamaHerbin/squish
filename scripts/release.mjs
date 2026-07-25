#!/usr/bin/env node
/**
 * Pinch — release cutter.
 *
 * Pinch ships on two clocks, and only one of them is versioned:
 *
 * - The **web app** deploys continuously. Vercel's Git integration builds every
 *   push to `main`; there is no version gate and no tag involved. See
 *   `docs/deploy.md`.
 * - A **`v*` tag** is a milestone. It is what produces the macOS DMG (via
 *   `.github/workflows/macos.yml`) and what the CHANGELOG entry describes.
 *
 * This script cuts the second one:
 *
 *   npm run release patch          # 0.2.0 -> 0.2.1
 *   npm run release minor          # 0.2.0 -> 0.3.0
 *   npm run release major          # 0.2.0 -> 1.0.0
 *   npm run release 1.4.2          # an explicit target
 *   npm run release minor --dry-run
 *
 * `package.json` is the only file anyone edits by hand. This script derives the
 * rest: the two lockfiles, the Cargo crate version, the CHANGELOG heading and
 * the tag. It deliberately does **not** touch `src-tauri/tauri.conf.json`, or
 * anything in `src/` — those read the version rather than restating it, and
 * `src/lib/contracts/version.test.ts` fails the suite if that stops being true.
 *
 * It stops short of pushing. The last step is printed, not run, so a human
 * reads the diff before anything reaches the remote.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { changelogSection } from './changelog-section.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const p = (...segments) => path.join(ROOT, ...segments);

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const bumpArg = argv.find((arg) => !arg.startsWith('-'));

/** Run a command, hand back trimmed stdout, throw on a non-zero exit. */
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

/** Run a command for its side effect, streaming its output to the terminal. */
function runLoud(command, args, options = {}) {
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
}

function fail(message, hint) {
  console.error(`\n✗ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Version arithmetic                                                          */
/* -------------------------------------------------------------------------- */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function nextVersion(current, bump) {
  const match = SEMVER.exec(current);
  if (!match) fail(`package.json version "${current}" is not a semver triple.`);
  const [major, minor, patch] = match.slice(1).map(Number);

  switch (bump) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default: {
      if (!SEMVER.test(bump)) {
        fail(
          `"${bump}" is neither major|minor|patch nor a semver triple.`,
          'Usage: npm run release <major|minor|patch|x.y.z> [--dry-run]',
        );
      }
      // An explicit target must still move forwards, or the tag ordering and
      // the CHANGELOG stop telling the truth.
      const [nextMajor, nextMinor, nextPatch] = bump.split('.').map(Number);
      const ascending =
        nextMajor > major ||
        (nextMajor === major && nextMinor > minor) ||
        (nextMajor === major && nextMinor === minor && nextPatch > patch);
      if (!ascending) fail(`${bump} is not greater than the current ${current}.`);
      return bump;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Preflight                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Everything that must be true before a tag is worth cutting. Each check
 * explains how to satisfy it, because a release is exactly the moment nobody
 * wants to go spelunking.
 */
function preflight() {
  console.log('preflight');

  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') {
    fail(`on branch "${branch}", not main.`, 'Releases are cut from main: git switch main');
  }
  console.log('  branch                 main');

  const dirty = run('git', ['status', '--porcelain']);
  if (dirty) {
    fail(
      'the working tree has uncommitted changes.',
      'Commit or stash them first — the release commit must contain only the bump.',
    );
  }
  console.log('  working tree           clean');

  // A release that is not on the remote's main is a release nobody else can
  // reproduce, so compare against the fetched ref rather than trusting local.
  run('git', ['fetch', '--quiet', 'origin', 'main']);
  const ahead = run('git', ['rev-list', '--count', 'origin/main..HEAD']);
  const behind = run('git', ['rev-list', '--count', 'HEAD..origin/main']);
  if (ahead !== '0' || behind !== '0') {
    fail(
      `main is ${ahead} ahead and ${behind} behind origin/main.`,
      'Push or pull until they match, then re-run.',
    );
  }
  console.log('  origin/main            in sync');

  const tags = run('git', ['tag', '--list']).split('\n').filter(Boolean);
  console.log(`  existing tags          ${tags.length === 0 ? 'none' : tags.join(', ')}`);

  return { tags };
}

/** `npm run check` and `npm test`, the same gate CI applies. */
function verify() {
  console.log('\nverify');
  for (const [label, script] of [
    ['check', 'check'],
    ['test', 'test'],
  ]) {
    process.stdout.write(`  npm run ${label.padEnd(18)} `);
    try {
      run('npm', ['run', script]);
      console.log('ok');
    } catch (error) {
      console.log('FAILED');
      console.error(error.stdout ?? '');
      console.error(error.stderr ?? '');
      fail(`npm run ${script} failed.`, 'Fix it before cutting a release.');
    }
  }
}

/* -------------------------------------------------------------------------- */
/* CHANGELOG                                                                   */
/* -------------------------------------------------------------------------- */

const CHANGELOG = p('CHANGELOG.md');
const UNRELEASED = '## [Unreleased]';

/**
 * Read the `## [Unreleased]` body and refuse to continue if it is empty.
 *
 * This is the one check with teeth beyond mechanics: it makes a release without
 * notes impossible. The CHANGELOG here is an editorial document (Keep a
 * Changelog, thematic bold sub-headings, a `Known limitations` section) and no
 * generator writes it, so the only guard against forgetting is this one.
 */
function readUnreleased() {
  const text = fs.readFileSync(CHANGELOG, 'utf8');
  const start = text.indexOf(UNRELEASED);
  if (start === -1) {
    fail(
      `CHANGELOG.md has no "${UNRELEASED}" section.`,
      'Add one above the newest release heading and describe what has landed.',
    );
  }
  const after = start + UNRELEASED.length;
  const nextHeading = text.indexOf('\n## ', after);
  const body = text.slice(after, nextHeading === -1 ? text.length : nextHeading).trim();
  if (!body) {
    fail(
      `the "${UNRELEASED}" section of CHANGELOG.md is empty.`,
      'Describe what is shipping — a release with no notes is not a release.',
    );
  }
  return { text, body };
}

/**
 * Promote `## [Unreleased]` to a dated release heading, open a fresh empty one
 * above it, and add the link reference at the foot of the file.
 *
 * The em dash in the heading and the `[x.y.z]: …/releases/tag/vx.y.z` link form
 * both match what CHANGELOG.md already uses — this file's style is hand-made
 * and the script conforms to it rather than the other way round.
 */
function promoteChangelog(version, date) {
  const text = fs.readFileSync(CHANGELOG, 'utf8');
  const heading = `## [${version}] — ${date}`;
  let next = text.replace(UNRELEASED, `${UNRELEASED}\n\n${heading}`);

  const link = `[${version}]: https://github.com/RamaHerbin/squish/releases/tag/v${version}`;
  const firstLink = next.search(/^\[\d+\.\d+\.\d+\]: /m);
  next =
    firstLink === -1
      ? `${next.trimEnd()}\n\n${link}\n`
      : `${next.slice(0, firstLink)}${link}\n${next.slice(firstLink)}`;

  if (!DRY_RUN) fs.writeFileSync(CHANGELOG, next);
  return heading;
}

/* -------------------------------------------------------------------------- */
/* Version surfaces                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `npm version` is the right tool for package.json + package-lock.json: it
 * keeps both in step, including the lockfile's two root entries, which a
 * hand-rolled rewrite gets wrong. `--no-git-tag-version` because the commit and
 * the tag are made here, once, after every file has moved. No `preversion` /
 * `version` / `postversion` scripts exist in this package, so nothing else runs.
 */
function bumpNpm(version) {
  if (DRY_RUN) return;
  run('npm', ['version', version, '--no-git-tag-version']);
}

/**
 * The crate version is metadata only — `tauri-codegen` reads `config.version`,
 * so the macOS About panel and the DMG name follow package.json, not this. It
 * is kept in step anyway because a stale version in `cargo` output is
 * confusing, and `version.test.ts` asserts it.
 */
function bumpCargo(version) {
  const file = p('src-tauri/Cargo.toml');
  const text = fs.readFileSync(file, 'utf8');

  // Anchor on the [package] section so a dependency that happens to sit at the
  // same version can never be rewritten by accident.
  const packageStart = text.indexOf('[package]');
  if (packageStart === -1) fail('src-tauri/Cargo.toml has no [package] section.');
  const packageEnd = text.indexOf('\n[', packageStart + 1);
  const head = text.slice(0, packageStart);
  const section = text.slice(packageStart, packageEnd === -1 ? text.length : packageEnd);
  const tail = packageEnd === -1 ? '' : text.slice(packageEnd);

  const bumped = section.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
  if (bumped === section) fail('no version key found in src-tauri/Cargo.toml [package].');

  if (!DRY_RUN) fs.writeFileSync(file, `${head}${bumped}${tail}`);
}

/**
 * Refresh `src-tauri/Cargo.lock`'s own entry for the crate.
 *
 * `cargo metadata` resolves and rewrites the lockfile without compiling
 * anything, and `--offline` keeps it from reaching the network — the three
 * exact-pinned `@emnapi/*` devDependencies exist because dependency
 * re-resolution during CI has bitten this repo before, and a release is not
 * the moment to let a resolver wander.
 */
function refreshCargoLock() {
  if (DRY_RUN) return;
  try {
    run('cargo', [
      'metadata',
      '--manifest-path',
      'src-tauri/Cargo.toml',
      '--offline',
      '--format-version',
      '1',
    ]);
  } catch {
    fail(
      'could not refresh src-tauri/Cargo.lock — is cargo installed?',
      'Run `cargo metadata --manifest-path src-tauri/Cargo.toml --offline` by hand, then commit.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

if (!bumpArg) {
  fail(
    'no bump given.',
    'Usage: npm run release <major|minor|patch|x.y.z> [--dry-run]',
  );
}

const pkgFile = p('package.json');
const current = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version;
const version = nextVersion(current, bumpArg);
const tag = `v${version}`;
const date = new Date().toISOString().slice(0, 10);

console.log(`\nPinch ${current} → ${version}${DRY_RUN ? '  (dry run)' : ''}\n`);

const { tags } = DRY_RUN ? { tags: [] } : preflight();
if (tags.includes(tag)) fail(`tag ${tag} already exists.`);

const { body } = readUnreleased();
console.log(`\nchangelog\n  [Unreleased]           ${body.split('\n').length} line(s) of notes`);

if (!DRY_RUN) verify();

console.log('\nbump');
bumpNpm(version);
console.log('  package.json           ' + version);
console.log('  package-lock.json      ' + version);
bumpCargo(version);
console.log('  src-tauri/Cargo.toml   ' + version);
refreshCargoLock();
console.log('  src-tauri/Cargo.lock   ' + version);
const heading = promoteChangelog(version, date);
console.log(`  CHANGELOG.md           ${heading}`);
console.log('  tauri.conf.json        (untouched — reads ../package.json)');
console.log('  src/                   (untouched — reads __APP_VERSION__)');

if (DRY_RUN) {
  console.log('\nDry run: nothing written. Re-run without --dry-run to cut the release.\n');
  process.exit(0);
}

console.log('\ncommit');
const staged = [
  'package.json',
  'package-lock.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'CHANGELOG.md',
];
runLoud('git', ['add', ...staged]);
run('git', ['commit', '-m', `chore(release): ${tag}`]);
console.log(`  chore(release): ${tag}`);

// Annotated, with the changelog section as the message: `git show v0.2.0` then
// tells the whole story without a network round trip.
run('git', ['tag', '-a', tag, '-m', `Pinch ${tag}\n\n${changelogSection(version)}`]);
console.log(`  tag ${tag}`);

console.log(`
Done locally. Nothing has been pushed.

  git show ${tag}                       # read it back
  git push origin main --follow-tags     # cut it

Pushing the tag starts .github/workflows/macos.yml, which builds the universal
DMG and opens a *draft* GitHub Release with these notes. Review the download,
then publish it.
`);
