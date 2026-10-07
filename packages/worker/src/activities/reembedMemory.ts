import { heartbeat, log } from '@temporalio/activity';
import { mapWithConcurrency } from '../lib/boundedMap.js';
import { currentEmbeddingSpec } from '../lib/embeddings.js';
import { listStaleMemoryIds, reembedMemoryItem } from '../lib/memoryStore.js';

/** Input for {@link reembedMemoryItemActivity} (mirrors the workflow arg). */
export interface ReembedMemoryInput {
  memoryId: string;
}

/**
 * Re-embed a single `memory_items` row from its current `lesson_summary`.
 *
 * Started (via the {@link ReembedMemoryWorkflow}) after an admin edits a channel
 * memory item's text: the gateway has already written the new `lesson_summary` /
 * `rationale`, so the stored pgvector `embedding` is now stale. This regenerates
 * it so semantic retrieval matches the current text.
 *
 * Best-effort: a missing row (e.g. deleted between edit and re-embed) is logged
 * and treated as a no-op rather than an error — there's nothing to re-embed.
 */
export async function reembedMemoryItemActivity(input: ReembedMemoryInput): Promise<void> {
  const reembedded = await reembedMemoryItem(input.memoryId);
  if (!reembedded) {
    log.warn('reembedMemoryItemActivity: memory item not found; skipping re-embed', {
      memoryId: input.memoryId,
    });
  }
}

export interface ReembedStaleMemoryBatchInput {
  /** Cursor: the last id the previous batch looked at, or null to start. */
  afterId: string | null;
  batchSize: number;
}

export interface ReembedStaleMemoryBatchResult {
  reembedded: number;
  failed: number;
  /** The last id this batch looked at; the next batch's cursor. */
  lastId: string | null;
  /** No stale rows were left after the cursor. */
  done: boolean;
}

/** Embedding calls in flight at once; each is one provider request. */
const REEMBED_CONCURRENCY = 4;

/**
 * Re-embed one batch of the rows the current embedding model did not produce,
 * so they rejoin recall and consolidation after an embedding-model change. A
 * row that fails is counted and skipped — the cursor moves past it — so one bad
 * row cannot stall the walk; a later run picks it up again.
 */
export async function reembedStaleMemoryBatch(
  input: ReembedStaleMemoryBatchInput
): Promise<ReembedStaleMemoryBatchResult> {
  const spec = await currentEmbeddingSpec();
  const ids = await listStaleMemoryIds(spec, input.afterId, input.batchSize);
  if (ids.length === 0) {
    return { done: true, failed: 0, lastId: input.afterId, reembedded: 0 };
  }
  const outcomes = await mapWithConcurrency(ids, REEMBED_CONCURRENCY, async (id) => {
    try {
      const ok = await reembedMemoryItem(id);
      heartbeat();
      return ok ? 'reembedded' : 'gone';
    } catch (err) {
      log.warn('reembedStaleMemoryBatch: re-embed failed; skipping row', {
        error: err instanceof Error ? err.message : String(err),
        memoryId: id,
      });
      return 'failed';
    }
  });
  return {
    done: ids.length < input.batchSize,
    failed: outcomes.filter((o) => o === 'failed').length,
    lastId: ids[ids.length - 1] ?? input.afterId,
    reembedded: outcomes.filter((o) => o === 'reembedded').length,
  };
}
