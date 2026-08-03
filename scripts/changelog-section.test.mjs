import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { changelogSection } from './changelog-section.mjs';

/**
 * `.mjs` rather than `.ts`, beside the `.mjs` it covers: `tsconfig.json`
 * includes only `src/`, so a `.ts` file here would run under vitest but never
 * be type-checked, which is worse than plain JS that is honest about it.
 *
 * What is being pinned is the seam between two authors of the same file.
 * release-please writes the heading — with a compare link glued to the version
 * and the date in parentheses — and this extractor reads it, in the one step
 * that turns CHANGELOG.md into the GitHub Release body. Nothing else fails if
 * that regex stops matching: the workflow would just publish an empty release.
 */

const CHANGELOG = fileURLToPath(new URL('../CHANGELOG.md', import.meta.url));

describe('changelogSection', () => {
  it('reads the heading shape release-please writes', () => {
    const text = [
      '# Changelog',
      '',
      '## [0.2.0](https://github.com/RamaHerbin/squish/compare/v0.1.0...v0.2.0) (2026-08-02)',
      '',
      '### Added',
      '',
      '* **pdf:** full-page before/after preview',
      '',
      '## [0.1.0] — 2026-07-25',
      '',
      'Initial public release.',
      '',
    ].join('\n');

    expect(changelogSection('0.2.0', text)).toBe('### Added\n\n* **pdf:** full-page before/after preview');
    expect(changelogSection('0.1.0', text)).toBe('Initial public release.');
  });

  it('stops at the link-reference block the oldest section runs into', () => {
    // 0.1.0's section is the last one in the real file, so it butts up against
    // the `[0.1.0]: …` footer. Those are Markdown plumbing, not release notes.
    const text = [
      '## [0.1.0] — 2026-07-25',
      '',
      'Initial public release.',
      '',
      '[0.1.0]: https://github.com/RamaHerbin/squish/releases/tag/v0.1.0',
      '',
    ].join('\n');

    expect(changelogSection('0.1.0', text)).toBe('Initial public release.');
  });

  it('does not confuse 0.1.0 with 0.1.10', () => {
    // The dots are escaped, so `.` cannot match the digit in a longer version.
    const text = ['## [0.1.10] — 2026-09-01', '', 'Ten.', ''].join('\n');
    expect(changelogSection('0.1.0', text)).toBe('');
  });

  it('finds every version the committed CHANGELOG claims to document', () => {
    const text = readFileSync(CHANGELOG, 'utf8');
    const versions = [...text.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map(([, v]) => v);

    // Guards the migration itself: a file whose headings no longer parse would
    // otherwise pass this suite by having nothing to check.
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect(changelogSection(version, text), `no notes for ${version}`).not.toBe('');
    }
  });
});
