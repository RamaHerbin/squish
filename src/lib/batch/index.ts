/**
 * Batch mode — squish's answer to "I have a folder of 200 screenshots".
 *
 * Everything is wired through the shared contracts, so the batch queue is a
 * drop-in `BatchQueue` and the exporter is a drop-in `ZipExport`.
 *
 * ```ts
 * import { createBatchQueue } from './lib/batch';
 * import QueueView from './lib/batch/QueueView.svelte';
 *
 * const queue = createBatchQueue({ createWorkerBridge });
 * ```
 *
 * `QueueView.svelte` is imported directly (a barrel cannot re-export a
 * component without dragging Svelte into every consumer of this module).
 */

export {
  MAX_BATCH_CONCURRENCY,
  acceptsDrop,
  createBatchQueue,
  messageOf,
  recommendedBatchConcurrency,
  type BatchQueueStore,
  type BatchQueueStoreOptions,
} from './queue.svelte';

export {
  BATCH_ENCODER_OUTPUT,
  decodeToImageData,
  encodeBatchFile,
  encodeImageData,
  outputNameFor,
  outputTypeFor,
  resizeImageData,
  sniffFileMimeType,
  type BatchEncodeContext,
  type BatchEncodeFn,
} from './pipeline';

export {
  downloadBlob,
  downloadZip,
  exportZip,
  zipEntryPath,
  zippableItems,
} from './zip';

export {
  THUMBNAIL_CONCURRENCY,
  THUMBNAIL_SIZE,
  createThumbnailCache,
  renderThumbnail,
  type ThumbnailCache,
  type ThumbnailCacheOptions,
} from './thumbnails';

export {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FILES,
  basename,
  dirname,
  joinPath,
  looksLikeImage,
  pickedFilesFromDataTransfer,
  pickedFilesFromFileList,
  pickedFilesFromSnapshot,
  relativePathOf,
  sanitizeZipPath,
  snapshotDataTransfer,
  type CollectOptions,
  type DropSnapshot,
  type PickedFile,
} from './files';

export {
  STAGE_ROOT_DIR,
  createFileStage,
  createMemoryStage,
  createOpfsStage,
  isOpfsSupported,
  type StagedFileStore,
} from './opfs';

export {
  ENCODER_LABELS,
  clamp01,
  encoderLabel,
  formatBytes,
  formatPercent,
  formatResize,
  formatSaved,
  hasQuality,
  qualityOf,
  savedFraction,
  settingsFacts,
  splitPath,
  type SettingsFact,
} from './format';
