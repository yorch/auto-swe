import { log } from '@temporalio/activity';
import { reembedMemoryItem } from '../lib/memoryStore.js';

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
