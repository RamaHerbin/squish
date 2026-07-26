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

/** CICP colour primaries (ITU-T H.273): wide-gamut codes we widen to P3 for. */
const PRIMARIES_BT2020 = 9;
const PRIMARIES_DCI_P3 = 11;
const PRIMARIES_DISPLAY_P3 = 12;

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

interface Nclx {
  primaries: number;
  transfer: number;
}

function u16(bytes: Uint8Array, at: number): number | undefined {
  const hi = bytes[at];
  const lo = bytes[at + 1];
  if (hi === undefined || lo === undefined) return undefined;
  return (hi << 8) | lo;
}

/**
 * Scan ISO-BMFF bytes for a `colr` box of colour type `nclx` and read its CICP
 * primaries + transfer. Layout after the 4-byte `colr`: colour_type(4)
 * primaries(2) transfer(2) matrix(2) full_range(1). Here `typeAt` points at the
 * 4-byte colour type (`nclx`).
 */
function scanColrNclx(bytes: Uint8Array): Nclx | undefined {
  let at = 0;
  for (;;) {
    const hit = findSequence(bytes, 'colr', at);
    if (hit === -1) return undefined;
    const typeAt = hit + 4;
    if (findSequence(bytes.subarray(typeAt, typeAt + 4), 'nclx') === 0) {
      const primaries = u16(bytes, typeAt + 4);
      const transfer = u16(bytes, typeAt + 4 + 2);
      if (primaries !== undefined && transfer !== undefined) return { primaries, transfer };
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
    const transfer = scanColrNclx(bytes)?.transfer;
    if (transfer === TRANSFER_PQ) return { kind: 'pq' };
    if (transfer === TRANSFER_HLG) return { kind: 'hlg' };
  }

  // Gain maps ride ASCII metadata in every container that carries them.
  for (const marker of GAIN_MAP_MARKERS) {
    if (findSequence(bytes, marker) !== -1) return { kind: 'gainmap' };
  }

  return undefined;
}

/**
 * The widest `ImageData` colour space worth decoding this source into. Answers
 * `display-p3` when the ISO-BMFF `nclx` primaries are wide-gamut (BT.2020 or
 * P3) — so PQ/BT.2020 and P3 sources are preserved instead of clipped to sRGB —
 * and `srgb` otherwise. The pipeline can only *represent* srgb | display-p3, so
 * BT.2020 is gamut-mapped into P3 (still strictly better than an sRGB clip).
 *
 * Only ISO-BMFF (AVIF/HEIC/HEIF) carries `nclx`; JPEG/PNG wide-gamut (ICC
 * Display-P3) is not covered here and stays sRGB for now.
 */
export function preferredColorSpace(
  bytes: Uint8Array,
  mimeType: ImageMimeType | '',
): PredefinedColorSpace {
  if (!BMFF_MIME_TYPES.has(mimeType)) return 'srgb';
  const primaries = scanColrNclx(bytes)?.primaries;
  if (
    primaries === PRIMARIES_BT2020 ||
    primaries === PRIMARIES_DCI_P3 ||
    primaries === PRIMARIES_DISPLAY_P3
  ) {
    return 'display-p3';
  }
  return 'srgb';
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
