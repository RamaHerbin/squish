/**
 * Swap, collapse and strip — the three destructive edits the compressor makes to
 * a loaded pdf-lib document.
 *
 * These are the only functions that mutate the object graph in place, and every
 * one of them has to reckon with the same pdf-lib fact: the writer serializes the
 * whole indirect-object map, not a reachability trace from the catalog. An object
 * you stop pointing at is not dropped — it is written anyway, at full size, unless
 * you `context.delete` its ref. So each edit here pairs a repoint with an explicit
 * delete of whatever it orphaned: the old soft mask a replaced JPEG no longer
 * carries, the duplicate streams a dedupe collapses, the metadata a strip removes.
 *
 * Pure pdf-lib and pure structure: no canvas, no worker, no pixels. That is what
 * lets compress.ts run these in Node and what makes rewrite.test.ts a
 * build-a-PDF / save / reload / inspect loop with nothing mocked.
 */

import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from '@cantoo/pdf-lib';

/** Interned name keys, looked up once. `PDFName.of` pools, so this is cheap. */
const KEY = {
  Type: PDFName.of('Type'),
  Subtype: PDFName.of('Subtype'),
  Image: PDFName.of('Image'),
  Form: PDFName.of('Form'),
  Width: PDFName.of('Width'),
  Height: PDFName.of('Height'),
  BitsPerComponent: PDFName.of('BitsPerComponent'),
  ColorSpace: PDFName.of('ColorSpace'),
  Filter: PDFName.of('Filter'),
  SMask: PDFName.of('SMask'),
  Resources: PDFName.of('Resources'),
  XObject: PDFName.of('XObject'),
  Metadata: PDFName.of('Metadata'),
  Thumb: PDFName.of('Thumb'),
} as const;

/**
 * Replace an image XObject's stream with a freshly encoded baseline JPEG.
 *
 * Builds a brand-new image dict rather than editing the old one: that is the only
 * reliable way to shed the keys a DCTDecode stream must not keep — `/DecodeParms`,
 * `/Decode`, a stale `/Indexed` or `/ICCBased` `/ColorSpace`, and the `/SMask` the
 * JPEG cannot carry. The dict mirrors what `JpegEmbedder.embedIntoContext` writes.
 *
 * Edge cases:
 * - No `/Length` key is set: `PDFStream.updateDict()` recomputes it from
 *   `getContentsSize()` at save time, so writing one here would only risk drift.
 * - The old stream's `/SMask` ref is captured before the swap and deleted after,
 *   because repointing the image ref leaves that soft-mask object orphaned but
 *   still serialized. If `ref` does not resolve to a `PDFRawStream` (already gone,
 *   or never a stream) there is nothing to capture and the assign still lands.
 * - `colorSpace` is constrained to the two baseline-JPEG families; the caller is
 *   responsible for never handing this a CMYK or indexed image.
 */
export function replaceImageStream(
  doc: PDFDocument,
  ref: PDFRef,
  jpegBytes: Uint8Array,
  meta: { width: number; height: number; colorSpace: 'DeviceRGB' | 'DeviceGray' },
): void {
  // 1. Capture the old /SMask ref BEFORE overwriting so it can be collected.
  const old = doc.context.lookup(ref);
  const smaskRef = old instanceof PDFRawStream ? old.dict.get(KEY.SMask) : undefined;

  // 2. Fresh dict — building (not merging) is what drops the stale keys.
  const dict = doc.context.obj({
    Type: 'XObject',
    Subtype: 'Image',
    Width: meta.width,
    Height: meta.height,
    BitsPerComponent: 8,
    ColorSpace: meta.colorSpace,
    Filter: 'DCTDecode',
  });

  // 3. Swap in place: every holder of this ref now points at the new stream.
  doc.context.assign(ref, PDFRawStream.of(dict, jpegBytes));

  // 4. Garbage-collect the orphaned soft mask.
  if (smaskRef instanceof PDFRef) doc.context.delete(smaskRef);
}

/**
 * Collapse byte-identical image XObjects onto one canonical object.
 *
 * Lossless and purely structural: two draws of the same logo become two `/XObject`
 * entries pointing at one stream. Bucketing is by a cheap structural-plus-FNV key,
 * but a hash collision must never merge two different images, so every in-bucket
 * pairing is confirmed with a full byte compare before it is trusted.
 *
 * Returns the number of duplicate refs collapsed (0 when nothing matched). After a
 * collapse the duplicate objects are `context.delete`d — otherwise the writer would
 * still emit them and the file would not shrink.
 */
export function dedupeImages(doc: PDFDocument): number {
  // 1. Collect every image XObject stream.
  const candidates: Array<{ ref: PDFRef; stream: PDFRawStream }> = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(KEY.Subtype) === KEY.Image) {
      candidates.push({ ref, stream: obj });
    }
  }

  // 2. Bucket by structural prefix + FNV-1a of the contents; confirm byte equality.
  const buckets = new Map<string, Array<{ ref: PDFRef; stream: PDFRawStream }>>();
  const dupToCanonical = new Map<PDFRef, PDFRef>();
  for (const cand of candidates) {
    const contents = cand.stream.getContents();
    const key = bucketKey(cand.stream.dict, contents);
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, [cand]);
      continue;
    }
    const canonical = bucket.find((prior) => bytesEqual(prior.stream.getContents(), contents));
    if (canonical) dupToCanonical.set(cand.ref, canonical.ref);
    else bucket.push(cand);
  }

  if (dupToCanonical.size === 0) return 0;

  // 3. Repoint every consumer: page + form /XObject dicts, and surviving /SMask refs.
  const visited = new Set<PDFRef>();
  for (const page of doc.getPages()) {
    repointResources(page.node, dupToCanonical, visited);
  }
  for (const cand of candidates) {
    if (dupToCanonical.has(cand.ref)) continue; // a survivor
    const sm = cand.stream.dict.get(KEY.SMask);
    if (sm instanceof PDFRef) {
      const canon = dupToCanonical.get(sm);
      if (canon) cand.stream.dict.set(KEY.SMask, canon);
    }
  }

  // 4. Drop the orphaned duplicates so the writer stops emitting them.
  for (const dupRef of dupToCanonical.keys()) doc.context.delete(dupRef);

  // 5. Number of refs collapsed.
  return dupToCanonical.size;
}

/**
 * Drop the document XMP metadata stream and every page thumbnail.
 *
 * Both `/Metadata` (catalog) and `/Thumb` (per page) are optional per ISO 32000, so
 * removal is structurally safe. The raw ref is read before the key is deleted so the
 * now-orphaned stream can itself be collected — a repoint alone would leave it in the
 * written file. Deliberately does NOT touch the Info dict or the accessibility tree,
 * per the `stripMetadata` setting's contract.
 */
export function stripMetadata(doc: PDFDocument): void {
  const metaRef = doc.catalog.get(KEY.Metadata);
  doc.catalog.delete(KEY.Metadata);
  if (metaRef instanceof PDFRef) doc.context.delete(metaRef);

  for (const page of doc.getPages()) {
    const thumbRef = page.node.get(KEY.Thumb);
    page.node.delete(KEY.Thumb);
    if (thumbRef instanceof PDFRef) doc.context.delete(thumbRef);
  }
}

/* -------------------------------------------------------------------------- */
/* Dedupe helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Bucket key = structural signature + a FNV-1a hash of the bytes. Same-bucket
 * candidates are still byte-compared before merging — the hash narrows, it never
 * proves. Reads dimensions/filter/colour space off the dict as raw names so an
 * `/Indexed` array vs a bare `/DeviceRGB` never share a bucket by accident.
 */
function bucketKey(dict: PDFDict, contents: Uint8Array): string {
  const w = nameOrNum(dict, KEY.Width);
  const h = nameOrNum(dict, KEY.Height);
  const bpc = nameOrNum(dict, KEY.BitsPerComponent);
  const cs = nameString(dict, KEY.ColorSpace);
  const filter = nameString(dict, KEY.Filter);
  return `${w}:${h}:${bpc}:${cs}:${filter}:${contents.length}:${fnv1a(contents)}`;
}

/** 32-bit FNV-1a as an unsigned decimal string. Bucket key only, never a proof. */
function fnv1a(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i]!;
    // 32-bit FNV prime 16777619, kept in unsigned 32-bit range via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(10);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Raw name string (with slash) at `key`, or `'x'` when absent/typed otherwise. */
function nameString(dict: PDFDict, key: PDFName): string {
  const value = dict.get(key);
  return value instanceof PDFName ? value.asString() : 'x';
}

/** The object's `toString()` at `key`, or `'x'` — covers PDFNumber dimensions. */
function nameOrNum(dict: PDFDict, key: PDFName): string {
  const value = dict.get(key);
  return value ? value.toString() : 'x';
}

/**
 * Repoint one node's `/Resources /XObject` entries to canonical refs, then recurse
 * into any form XObjects it draws. A `visited` set of form refs guards the cyclic
 * form references a malformed file can contain.
 */
function repointResources(
  node: PDFDict,
  dupToCanonical: Map<PDFRef, PDFRef>,
  visited: Set<PDFRef>,
): void {
  const resources = node.lookup(KEY.Resources);
  if (!(resources instanceof PDFDict)) return;
  const xobjects = resources.lookup(KEY.XObject);
  if (!(xobjects instanceof PDFDict)) return;

  for (const [nameKey, value] of xobjects.entries()) {
    if (value instanceof PDFRef) {
      const canon = dupToCanonical.get(value);
      if (canon) {
        xobjects.set(nameKey, canon);
        continue;
      }
    }
    // Recurse into form XObjects (their own /Resources may draw duplicates too).
    const resolved = value instanceof PDFRef ? node.context.lookup(value) : value;
    if (
      value instanceof PDFRef &&
      resolved instanceof PDFRawStream &&
      resolved.dict.get(KEY.Subtype) === KEY.Form &&
      !visited.has(value)
    ) {
      visited.add(value);
      repointResources(resolved.dict, dupToCanonical, visited);
    }
  }
}
