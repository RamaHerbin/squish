/**
 * HDR *detection* for incoming files.
 *
 * The pipeline is 8-bit sRGB `ImageData`: HDR sources are tone-mapped to SDR
 * at decode time (by the browser decoder, or by libheif for wasm HEIC). This
 * module only answers "was the source HDR?" so the UI can say so honestly —
 * it never affects pixels.
 *
 * Detection is a bounded byte scan, not a full container parse:
 *   - ISO-BMFF (AVIF/HEIC/HEIF): `colr` boxes of type `nclx` carry the CICP
 *     transfer characteristic — 16 is PQ (SMPTE ST 2084), 18 is HLG.
 *   - Gain-map HDR (Ultra HDR JPEG, Apple HEIC): ASCII markers in XMP/aux
 *     metadata (`hdrgm:`, ISO 21496 urn, Apple's hdrgainmap urn).
 * False negatives are possible (exotic layouts); false positives are not, in
 * practice — the markers do not occur in SDR files by accident.
 */

import type { HdrInfo, ImageMimeType } from '../contracts';

export type { HdrInfo, HdrKind } from '../contracts';

/** How much of the file header the detector reads. Metadata sits up front. */
export const HDR_SCAN_BYTES = 256 * 1024;

const BMFF_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/avif',
  'image/heic',
  'image/heif',
]);

const GAIN_MAP_MARKERS = [
  'hdrgm:Version',
  'urn:iso:std:iso:ts:21496',
  'urn:com:apple:photo:2020:aux:hdrgainmap',
] as const;

/** CICP transfer characteristics (ITU-T H.273). */
const TRANSFER_PQ = 16;
const TRANSFER_HLG = 18;

function findSequence(bytes: Uint8Array, ascii: string, from = 0): number {
  const needle = ascii;
  const limit = bytes.length - needle.length;
  outer: for (let i = from; i <= limit; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Scan ISO-BMFF bytes for a `colr` box of colour type `nclx` and read its
 * transfer characteristic. Layout after the 8-byte box header:
 * `nclx`(4) primaries(2) transfer(2) matrix(2) full_range(1).
 */
function scanColrTransfer(bytes: Uint8Array): number | undefined {
  let at = 0;
  for (;;) {
    const hit = findSequence(bytes, 'colr', at);
    if (hit === -1) return undefined;
    const typeAt = hit + 4;
    if (findSequence(bytes.subarray(typeAt, typeAt + 4), 'nclx') === 0) {
      const transferAt = typeAt + 4 + 2;
      const hi = bytes[transferAt];
      const lo = bytes[transferAt + 1];
      if (hi !== undefined && lo !== undefined) return (hi << 8) | lo;
    }
    at = hit + 4;
  }
}

/**
 * Detect whether the source file is HDR. Pass the leading
 * {@link HDR_SCAN_BYTES} of the file (less is fine — detection degrades to
 * "not detected", never throws).
 */
export function detectHdr(bytes: Uint8Array, mimeType: ImageMimeType | ''): HdrInfo | undefined {
  if (BMFF_MIME_TYPES.has(mimeType)) {
    const transfer = scanColrTransfer(bytes);
    if (transfer === TRANSFER_PQ) return { kind: 'pq' };
    if (transfer === TRANSFER_HLG) return { kind: 'hlg' };
  }

  // Gain maps ride ASCII metadata in every container that carries them.
  for (const marker of GAIN_MAP_MARKERS) {
    if (findSequence(bytes, marker) !== -1) return { kind: 'gainmap' };
  }

  return undefined;
}

/** Short UI label for an HDR source, e.g. `HDR (PQ)`. */
export function hdrLabel(info: HdrInfo): string {
  switch (info.kind) {
    case 'pq':
      return 'HDR (PQ)';
    case 'hlg':
      return 'HDR (HLG)';
    case 'gainmap':
      return 'HDR (gain map)';
  }
}
