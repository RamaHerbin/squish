#!/usr/bin/env node
/**
 * Print one version's section of CHANGELOG.md.
 *
 *   node scripts/changelog-section.mjs 0.2.0
 *
 * release-please drafts each section from commit subjects and a human rewrites
 * it in the release pull request, so by the time a tag exists CHANGELOG.md says
 * considerably more than the generated notes it started from. This is what lets
 * `.github/workflows/macos.yml` make that edited document the GitHub Release
 * body, replacing what release-please seeded the draft release with.
 *
 * Lives in its own file rather than inline in the workflow because escaping a
 * regex through YAML and then through a shell quote is a good way to ship a
 * subtly broken release, and because a file can have a test — see
 * `changelog-section.test.mjs`, which pins both heading shapes this file has to
 * read: the hand-written `## [0.1.0] — 2026-07-25` and the
 * `## [0.2.0](…compare…) (2026-08-02)` release-please writes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHANGELOG = path.join(fileURLToPath(new URL('..', import.meta.url)), 'CHANGELOG.md');

/**
 * The body under `## [x.y.z]`, up to the next `## ` heading. Returns an empty
 * string when there is no such section, so callers decide whether that is fatal.
 *
 * The oldest release is the last section in the file, so it runs into the
 * `[x.y.z]: …` link-reference block at the foot — those are Markdown plumbing,
 * not notes, and are trimmed off.
 */
export function changelogSection(version, text = fs.readFileSync(CHANGELOG, 'utf8')) {
  const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm');
  const start = text.search(heading);
  if (start === -1) return '';
  const after = text.indexOf('\n', start) + 1;
  const next = text.indexOf('\n## ', after);
  const body = text.slice(after, next === -1 ? text.length : next);
  const links = body.search(/^\[[^\]]+\]: \S+$/m);
  return (links === -1 ? body : body.slice(0, links)).trim();
}

// Only act as a CLI when run directly, so importing it stays side-effect free.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const version = (process.argv[2] ?? '').replace(/^v/, '');
  if (!version) {
    console.error('Usage: node scripts/changelog-section.mjs <x.y.z>');
    process.exit(1);
  }
  const body = changelogSection(version);
  if (!body) {
    console.error(`CHANGELOG.md has no section for ${version}`);
    process.exit(1);
  }
  process.stdout.write(`${body}\n`);
}
