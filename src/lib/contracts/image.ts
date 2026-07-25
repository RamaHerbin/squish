/**
 * Source image + MIME sniffing contracts.
 *
 * Dependency-free: types and tiny pure helpers only.
 */

/* -------------------------------------------------------------------------- */
/* MIME types                                                                  */
/* -------------------------------------------------------------------------- */

/** Every image MIME type squish can recognise on input. */
export type ImageMimeType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/avif'
  | 'image/jxl'
  | 'image/gif'
  | 'image/bmp'
  | 'image/tiff'
  | 'image/qoi'
  | 'image/heic'
  | 'image/heif'
  | 'image/svg+xml';

/** Types the magic-number sniffer can report (images + a PDF trap). */
export type SniffableMimeType = ImageMimeType | 'application/pdf';

/** How a MIME type was determined. Magic numbers beat everything else. */
export type MimeSniffSource = 'magic-number' | 'file-type' | 'extension' | 'unknown';

export interface MimeSniffResult {
  /** Detected type, or `''` when nothing matched. */
  mimeType: ImageMimeType | '';
  /** Provenance of {@link MimeSniffResult.mimeType}. */
  source: MimeSniffSource;
  /**
   * True when the bytes look like a non-image file we explicitly recognise
   * (currently only PDF). Callers should show a friendly error rather than
   * attempting a decode.
   */
  unsupported?: SniffableMimeType;
}

/**
 * Number of leading bytes needed by {@link sniffMimeTypeFromBytes}.
 * Read at least this many: `await blob.slice(0, MIME_SNIFF_BYTES).arrayBuffer()`.
 */
export const MIME_SNIFF_BYTES = 32;

/**
 * Magic-number table, ported from Squoosh.
 * Matched against a latin1 string built from the first {@link MIME_SNIFF_BYTES}.
 * Order matters — first match wins.
 */
const MAGIC_NUMBERS: ReadonlyArray<readonly [RegExp, SniffableMimeType]> = [
  [/^%PDF-/, 'application/pdf'],
  [/^GIF87a/, 'image/gif'],
  [/^GIF89a/, 'image/gif'],
  [/^\x89PNG\x0D\x0A\x1A\x0A/, 'image/png'],
  [/^\xFF\xD8\xFF/, 'image/jpeg'],
  [/^BM/, 'image/bmp'],
  [/^I I/, 'image/tiff'],
  [/^II\*/, 'image/tiff'],
  [/^MM\x00\*/, 'image/tiff'],
  [/^RIFF....WEBPVP8[LX ]/s, 'image/webp'],
  [/^\x00\x00\x00 ftypavif\x00\x00\x00\x00/, 'image/avif'],
  // ISO-BMFF: 4-byte box size, "ftyp", then the major brand at offset 8.
  [/^....ftyp(?:heic|heix|hevc|hevx|heim|heis|hevm|hevs)/s, 'image/heic'],
  // mif1/msf1 are brand-agnostic HEIF containers (rarely, an AVIF hides in
  // one — the decode chain falls back to the browser decoder if wasm balks).
  [/^....ftyp(?:mif1|msf1|heif)/s, 'image/heif'],
  [/^\xff\x0a/, 'image/jxl'],
  [/^\x00\x00\x00\x0cJXL \x0d\x0a\x87\x0a/, 'image/jxl'],
  [/^qoif/, 'image/qoi'],
  // SVG has no magic number. These cover the overwhelming majority of files;
  // a false positive is harmless because SVG parsing fails loudly.
  [/^\s*<svg[\s>]/i, 'image/svg+xml'],
  [/^\s*<\?xml[\s\S]*?<svg[\s>]/i, 'image/svg+xml'],
];

/** Canonical file extension (no leading dot) per image MIME type. */
export const EXTENSION_BY_MIME: Readonly<Record<ImageMimeType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/jxl': 'jxl',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
  'image/qoi': 'qoi',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/svg+xml': 'svg',
};

const MIME_BY_EXTENSION: Readonly<Record<string, ImageMimeType>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  jxl: 'image/jxl',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  qoi: 'image/qoi',
  heic: 'image/heic',
  heif: 'image/heif',
  svg: 'image/svg+xml',
};

/**
 * Sniff an image MIME type from the leading bytes of a file.
 * Pure and synchronous — read the bytes yourself, then call this.
 *
 * @returns the detected type, or `''` when nothing matched.
 */
export function sniffMimeTypeFromBytes(bytes: Uint8Array): SniffableMimeType | '' {
  let latin1 = '';
  const limit = Math.min(bytes.length, MIME_SNIFF_BYTES);
  for (let i = 0; i < limit; i++) latin1 += String.fromCodePoint(bytes[i] ?? 0);

  for (const [detector, mimeType] of MAGIC_NUMBERS) {
    if (detector.test(latin1)) return mimeType;
  }
  return '';
}

/** Best-effort MIME type from a filename. Fallback when sniffing fails. */
export function mimeTypeFromFilename(name: string): ImageMimeType | '' {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  if (!match) return '';
  const ext = match[1];
  if (ext === undefined) return '';
  return MIME_BY_EXTENSION[ext.toLowerCase()] ?? '';
}

/** Swap (or append) a file extension: `photo.png` + `webp` → `photo.webp`. */
export function replaceExtension(filename: string, extension: string): string {
  return /\.[^./\\]*$/.test(filename)
    ? filename.replace(/\.[^./\\]*$/, `.${extension}`)
    : `${filename}.${extension}`;
}

/** SVG is the only vector input; it takes a separate decode/resize path. */
export function isVectorMimeType(mimeType: string): mimeType is 'image/svg+xml' {
  return mimeType === 'image/svg+xml';
}

/* -------------------------------------------------------------------------- */
/* Source image                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Retained SVG markup for the loaded source.
 *
 * Kept as text (not an `HTMLImageElement`) so it survives structured clone and
 * can be re-rasterised at any target size — that is how "vector" resizing stays
 * crisp instead of upscaling a bitmap.
 */
export interface VectorSource {
  /** Full SVG markup, guaranteed to carry explicit `width`/`height`. */
  svgText: string;
}

/**
 * `accept` value for every file picker. `image/*` alone is not enough: systems
 * that never registered QOI/JXL/HEIC MIME types would grey those files out, so
 * every supported extension is listed explicitly alongside it.
 */
export const FILE_PICKER_ACCEPT: string = [
  'image/*',
  ...new Set([
    ...Object.values(EXTENSION_BY_MIME).map((ext) => `.${ext}`),
    ...Object.keys(MIME_BY_EXTENSION).map((ext) => `.${ext}`),
  ]),
].join(',');

/** The per-file ceiling the UI advertises ("MAX 50 MB / FILE"). */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Split files into those within {@link MAX_FILE_BYTES} and those over it. */
export function partitionBySize(files: readonly File[]): {
  accepted: File[];
  oversized: File[];
} {
  const accepted: File[] = [];
  const oversized: File[] = [];
  for (const file of files) (file.size > MAX_FILE_BYTES ? oversized : accepted).push(file);
  return { accepted, oversized };
}

/** How a source file signalled HDR. Pixels are tone-mapped to SDR at decode. */
export type HdrKind = 'pq' | 'hlg' | 'gainmap';

export interface HdrInfo {
  kind: HdrKind;
}

/** The user's currently-loaded image, after decode. */
export interface SourceImage {
  /** The original `File` exactly as picked/dropped/pasted. */
  file: File;
  /** Full-size RGBA pixels decoded from {@link SourceImage.file}. */
  decoded: ImageData;
  /** Present only for SVG inputs. */
  vector?: VectorSource;
  /** Present when the source was HDR (decoded pixels are tone-mapped SDR). */
  hdr?: HdrInfo;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/** Pixel dimensions of any `ImageData`-like value. */
export function dimensionsOf(image: ImageDimensions): ImageDimensions {
  return { width: image.width, height: image.height };
}
