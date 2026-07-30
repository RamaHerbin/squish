/**
 * PDF compression — the one feature that is not an image job.
 *
 * ```svelte
 * import { PdfView, createPdfJob } from '$lib/pdf';
 * ```
 *
 * The whole screen is `PdfView` plus the file it should read: it owns its own
 * {@link PdfJob}, starts the analysis on mount, and calls `onclose` when the
 * document is one Pinch will not touch. Everything below it — the analysis, the
 * plan, the rewrite — is reachable here too, for anything that wants the engine
 * without the screen.
 *
 * Types and constants live in `contracts/pdf.ts` (re-exported from
 * `$lib/contracts`) so a caller can name a `PdfAnalysis` without importing
 * pdf-lib. Unlike `batch/index.ts`, this barrel does re-export its component:
 * the PDF view is the module's whole public surface, and every consumer of it is
 * a Svelte file already.
 */

export { default as PdfView } from './PdfView.svelte';

export { createPdfJob, type PdfJob, type PdfPhase } from './pdf-job.svelte';

export { analyzePdf } from './analyze';
export { compressPdf, type PdfCompressDeps } from './compress';
