/**
 * PDF compression contracts.
 *
 * Deliberately parallel to the image contracts rather than folded into them.
 * A PDF job is `ArrayBuffer -> ArrayBuffer`: it has no `ImageData`, no width
 * and height of its own, and no `SideSettings`. Widening `EncoderId` to reach
 * it would push a nonsense variant into `SideSettings`, `Preset`,
 * `BatchQueue.start()` and `MatrixCell`, and `isSideSettingsShape` would reject
 * the result anyway because it requires a numeric `processorState.resize`.
 *
 * The names here are prefixed `Pdf*` on purpose: `contracts/index.ts` is a flat
 * `export *` barrel, so a bare `DecodeResult` or `EncoderId` would collide.
 *
 * ## What can actually go back into a PDF
 *
 * ISO 32000 allows a closed set of stream filters, and none of Pinch's headline
 * encoders are in it. AVIF, JPEG XL, WebP and QOI cannot be embedded at all.
 * That leaves `DCTDecode` (JPEG, via MozJPEG) for photographic content and
 * `FlateDecode` (raw samples + zlib) for everything else — which is why this
 * feature has a quality slider and a DPI target rather than an encoder matrix.
 */

/** The one MIME type this feature reads and writes. */
export const PDF_MIME_TYPE = 'application/pdf';

/**
 * Accept string for a file picker that should take PDFs.
 *
 * Separate from `FILE_PICKER_ACCEPT`, which hardcodes `image/*`. Callers that
 * want both concatenate them.
 */
export const PDF_FILE_PICKER_ACCEPT = 'application/pdf,.pdf';

/**
 * Per-file ceiling for PDFs, three times the image limit.
 *
 * PDFs run larger than images and the work is sequential and streamed, so the
 * ceiling is about peak memory during one image's decode rather than the file
 * itself. Mirrored in `src-tauri/src/lib.rs`; `pdf.test.ts` binds the two.
 */
export const PDF_MAX_FILE_BYTES = 150 * 1024 * 1024;

/**
 * The single message shown when a PDF reaches an image-only code path.
 *
 * Three different strings used to say this in three pipelines. Now they all
 * point at the page that can actually do something with the file.
 */
export const PDF_NOT_AN_IMAGE_MESSAGE =
  'PDFs are compressed on the PDF page, not in the image editor';

/* -------------------------------------------------------------------------- */
/* Document analysis                                                           */
/* -------------------------------------------------------------------------- */

/** The stream filter an embedded image arrived in. */
export type PdfImageFilter =
  | 'DCTDecode'
  | 'FlateDecode'
  | 'JPXDecode'
  | 'CCITTFaxDecode'
  | 'JBIG2Decode'
  | 'LZWDecode'
  | 'RunLengthDecode'
  | 'unknown';

/** Filters this feature can decode, and therefore recompress. */
export const PDF_RECOMPRESSIBLE_FILTERS: readonly PdfImageFilter[] = ['DCTDecode', 'FlateDecode'];

/**
 * Why an image was left exactly as it was found.
 *
 * Every one of these is reported per image rather than swallowed: "we did not
 * touch this and here is why" is more useful than a single document-level
 * percentage.
 */
export type PdfSkipReason =
  /** JPEG 2000, JBIG2 or CCITT — decoding these means shipping another decoder. */
  | 'no-decoder'
  /** CMYK. Adobe writes these inverted with an APP14 marker; getting it wrong
   *  produces a colour negative rather than a soft image. */
  | 'cmyk'
  /** A 1-bit stencil or a colour-key mask. Nothing to gain, plenty to break. */
  | 'mask'
  /** An `/Indexed`, `/Separation` or otherwise unhandled colour space. */
  | 'colorspace'
  /** Below the size where recompressing is worth a decode. */
  | 'too-small'
  /** Recompressed fine, but the result was not smaller, so the original stayed. */
  | 'not-smaller'
  /** The decode or encode threw. The original stayed. */
  | 'error';

/** One embedded image, as found in the document. */
export interface PdfImageInfo {
  /** Object reference, e.g. `"12 0 R"`. Stable within one load. */
  readonly ref: string;
  /** Zero-based pages that draw this image. Empty when it is never drawn. */
  readonly pageIndices: readonly number[];
  readonly width: number;
  readonly height: number;
  readonly filter: PdfImageFilter;
  /** Raw `/ColorSpace` as written, e.g. `"/DeviceRGB"` or `"/ICCBased"`. */
  readonly colorSpace: string;
  readonly bitsPerComponent: number;
  /** True when a separate `/SMask` object carries the alpha channel. */
  readonly hasSMask: boolean;
  /** True for `/ImageMask` stencils. */
  readonly isMask: boolean;
  /** Bytes of the encoded stream as stored. */
  readonly srcBytes: number;
  /**
   * Resolution the image is actually drawn at, from the content-stream walk.
   * `undefined` when the walk could not place it — then only an absolute pixel
   * cap applies, never a DPI target.
   */
  readonly effectiveDpi?: number;
}

/** What happened to one image during a compress run. */
export interface PdfImageOutcome {
  readonly ref: string;
  readonly srcBytes: number;
  /** Absent when the image was skipped. */
  readonly outBytes?: number;
  /** Set when the image was resampled. */
  readonly resampledTo?: { readonly width: number; readonly height: number };
  /** `null` means measured but unmeasurable, matching `verdictFor`. */
  readonly ssim?: number | null;
  readonly skipped?: PdfSkipReason;
  readonly error?: string;
}

/** Why a document cannot be compressed at all. */
export type PdfRefusal =
  /** Rewriting a file we cannot decrypt produces a broken file. */
  | 'encrypted'
  /** Any rewrite invalidates a digital signature. Refusing is the honest move. */
  | 'signed'
  /** Not a PDF, or damaged beyond pdf-lib's tolerance. */
  | 'unreadable';

/** The result of reading a document without changing it. */
export interface PdfAnalysis {
  readonly pageCount: number;
  readonly srcBytes: number;
  readonly images: readonly PdfImageInfo[];
  /** Total bytes held by embedded image streams. */
  readonly imageBytes: number;
  /** Set when the document must not be touched. `images` is then empty. */
  readonly refusal?: PdfRefusal;
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export interface PdfCompressSettings {
  /** MozJPEG quality for recompressed photographic images, 1-100. */
  readonly imageQuality: number;
  /**
   * Resample anything drawn above this resolution down to it. `null` leaves
   * every image at its stored size.
   */
  readonly targetDpi: number | null;
  /**
   * Hard ceiling on the longest edge, applied when an image could not be placed
   * by the content-stream walk and `targetDpi` therefore cannot be evaluated.
   */
  readonly maxPixels: number | null;
  /** Re-encode raw `FlateDecode` photographs as JPEG. */
  readonly flateToJpeg: boolean;
  /** Point byte-identical image streams at a single object. Lossless. */
  readonly dedupeImages: boolean;
  /** Drop XMP metadata and page thumbnails. Keeps the accessibility tree. */
  readonly stripMetadata: boolean;
  /** Measure SSIM per recompressed image. Costs a second decode each. */
  readonly measure: boolean;
}

export const PDF_QUALITY_RANGE = { min: 40, max: 95, step: 1 } as const;
export const PDF_DPI_PRESETS: readonly number[] = [96, 150, 200, 300];

/**
 * Defaults aimed at "smaller, and nobody notices".
 *
 * 150 DPI is the usual print-legible floor and what Ghostscript's `/ebook`
 * profile targets; q78 is a notch above the point where MozJPEG starts to show
 * ringing on text-adjacent images.
 */
export const DEFAULT_PDF_SETTINGS: PdfCompressSettings = {
  imageQuality: 78,
  targetDpi: 150,
  maxPixels: 2400,
  flateToJpeg: true,
  dedupeImages: true,
  stripMetadata: true,
  measure: false,
};

/** Below this, a decode plus an encode costs more than it can possibly save. */
export const PDF_MIN_IMAGE_BYTES = 4 * 1024;

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

export interface PdfCompressResult {
  readonly bytes: ArrayBuffer;
  readonly srcBytes: number;
  readonly outBytes: number;
  readonly images: readonly PdfImageOutcome[];
  /** Images whose stream was actually replaced. */
  readonly replaced: number;
  /** Duplicate image objects collapsed by the dedupe pass. */
  readonly deduped: number;
  readonly ms: number;
}

/** Bytes saved across every image that was replaced. */
export function pdfImageBytesSaved(images: readonly PdfImageOutcome[]): number {
  let saved = 0;
  for (const image of images) {
    if (image.outBytes === undefined) continue;
    saved += image.srcBytes - image.outBytes;
  }
  return saved;
}

/** Human label for a skip reason, for the per-image table. */
export function pdfSkipLabel(reason: PdfSkipReason): string {
  switch (reason) {
    case 'no-decoder':
      return 'No decoder';
    case 'cmyk':
      return 'CMYK';
    case 'mask':
      return 'Mask';
    case 'colorspace':
      return 'Colour space';
    case 'too-small':
      return 'Too small';
    case 'not-smaller':
      return 'No gain';
    case 'error':
      return 'Failed';
  }
}
