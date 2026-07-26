/**
 * Five-entry LRU for encode results, ported from Squoosh's `result-cache.ts`.
 *
 * The point is scrubbing: drag quality 75 → 40 → 75 and the third value comes
 * back instantly instead of re-running wasm. Depth 5 is Squoosh's number — deep
 * enough for a slider wiggle, shallow enough that a handful of full-size
 * `ImageData` buffers do not sink a phone.
 *
 * ## Matching rules
 * - `preprocessed` is compared by **identity** (`===`). That is deliberate: the
 *   job engine keeps exactly one preprocessed `ImageData` per
 *   (source, preprocessorState), so identity is both cheaper and stricter than
 *   any structural check on a few million pixels. Rotate the image, get new
 *   pixels, miss the cache — correct.
 * - `processorState` uses {@link processorStateEqual}, so two *disabled* resize
 *   configs match even when the stale width/height behind the switch differ.
 * - `encoderOptions` uses {@link shallowEqual}; every option shape is flat.
 *
 * No runes here — this is a plain object so the engine can hold it privately and
 * keep raw (unproxied) `ImageData` references, which is what makes the identity
 * check above trustworthy.
 */

import { processorStateEqual, shallowEqual, RESULT_CACHE_SIZE } from '../contracts';
import type {
  AnyEncoderOptions,
  EncoderId,
  ProcessorState,
  ResultCache,
  ResultCacheEntry,
  ResultCacheHit,
} from '../contracts';

export class LruResultCache implements ResultCache {
  /** Maximum retained entries. `0` disables caching entirely. */
  readonly size: number;

  #entries: ResultCacheEntry[] = [];

  constructor(size: number = RESULT_CACHE_SIZE) {
    this.size = Number.isFinite(size) ? Math.max(0, Math.floor(size)) : RESULT_CACHE_SIZE;
  }

  /** Most-recently-used first. Exposed for tests and debugging. */
  get entries(): readonly ResultCacheEntry[] {
    return this.#entries;
  }

  add(entry: ResultCacheEntry): void {
    if (this.size === 0) return;
    this.#entries.unshift(entry);
    if (this.#entries.length > this.size) this.#entries.length = this.size;
  }

  match(
    preprocessed: ImageData,
    processorState: ProcessorState,
    encoderId: EncoderId,
    encoderOptions: AnyEncoderOptions,
  ): ResultCacheHit | undefined {
    const index = this.#entries.findIndex(
      (entry) =>
        entry.preprocessed === preprocessed &&
        entry.encoderId === encoderId &&
        processorStateEqual(entry.processorState, processorState) &&
        shallowEqual(entry.encoderOptions, encoderOptions),
    );
    if (index === -1) return undefined;

    const entry = this.#entries[index];
    if (!entry) return undefined;

    // Promote to the front.
    if (index !== 0) {
      this.#entries.splice(index, 1);
      this.#entries.unshift(entry);
    }

    return {
      processed: entry.processed,
      data: entry.data,
      file: entry.file,
      encoderFallback: entry.encoderFallback,
    };
  }

  clear(): void {
    this.#entries.length = 0;
  }
}

export function createResultCache(size: number = RESULT_CACHE_SIZE): ResultCache {
  return new LruResultCache(size);
}
