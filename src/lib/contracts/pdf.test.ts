import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PDF_SETTINGS,
  MAX_FILE_BYTES,
  PDF_DPI_PRESETS,
  PDF_MAX_FILE_BYTES,
  PDF_QUALITY_RANGE,
  pdfSkipLabel,
  type PdfSkipReason,
} from './index';

/**
 * `PDF_MAX_FILE_BYTES` and the quality/DPI defaults live in `pdf.ts`, but two
 * of the numbers are also restated in Rust (`src-tauri/src/lib.rs` cannot
 * import TypeScript) and would drift silently if either side changed alone.
 * These tests are the enforcement, same pattern as `version.test.ts`:
 * deliberately reads the files off disk rather than importing them, so it
 * checks what is committed rather than what a bundler resolved.
 */

const repoFile = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8');

describe('PDF byte-ceiling mirrors', () => {
  it('MAX_PDF_READ_BYTES in src-tauri/src/lib.rs matches PDF_MAX_FILE_BYTES', () => {
    const rust = repoFile('src-tauri/src/lib.rs');
    const match = /const MAX_PDF_READ_BYTES:\s*u64\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024;/.exec(
      rust,
    );
    expect(
      match,
      'src-tauri/src/lib.rs has no `const MAX_PDF_READ_BYTES: u64 = N * 1024 * 1024;` — ' +
        'update the regex or the constant so the two stay bound',
    ).not.toBeNull();
    const megabytes = Number(match?.[1]);
    expect(
      megabytes * 1024 * 1024,
      'MAX_PDF_READ_BYTES (src-tauri/src/lib.rs) and PDF_MAX_FILE_BYTES (pdf.ts) have drifted apart',
    ).toBe(PDF_MAX_FILE_BYTES);
  });

  it('MAX_READ_BYTES in src-tauri/src/lib.rs matches MAX_FILE_BYTES', () => {
    const rust = repoFile('src-tauri/src/lib.rs');
    const match = /const MAX_READ_BYTES:\s*u64\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024;/.exec(rust);
    expect(
      match,
      'src-tauri/src/lib.rs has no `const MAX_READ_BYTES: u64 = N * 1024 * 1024;` — ' +
        'update the regex or the constant so the two stay bound',
    ).not.toBeNull();
    const megabytes = Number(match?.[1]);
    expect(
      megabytes * 1024 * 1024,
      'MAX_READ_BYTES (src-tauri/src/lib.rs) and MAX_FILE_BYTES ($lib/contracts) have drifted apart',
    ).toBe(MAX_FILE_BYTES);
  });
});

describe('DEFAULT_PDF_SETTINGS', () => {
  it('imageQuality falls within PDF_QUALITY_RANGE', () => {
    expect(DEFAULT_PDF_SETTINGS.imageQuality).toBeGreaterThanOrEqual(PDF_QUALITY_RANGE.min);
    expect(DEFAULT_PDF_SETTINGS.imageQuality).toBeLessThanOrEqual(PDF_QUALITY_RANGE.max);
  });

  it('targetDpi is one of PDF_DPI_PRESETS', () => {
    expect(PDF_DPI_PRESETS).toContain(DEFAULT_PDF_SETTINGS.targetDpi);
  });
});

describe('pdfSkipLabel', () => {
  // Exhaustive by construction: dropping a `PdfSkipReason` member here, or
  // `pdfSkipLabel` dropping a case, is a compile error rather than a gap the
  // runtime loop below could silently skip.
  const reasons: Record<PdfSkipReason, true> = {
    'no-decoder': true,
    cmyk: true,
    mask: true,
    colorspace: true,
    'too-small': true,
    'not-smaller': true,
    error: true,
  };

  it.each(Object.keys(reasons) as PdfSkipReason[])('has a non-empty label for %s', (reason) => {
    expect(pdfSkipLabel(reason)).not.toBe('');
  });
});
