import { continueAsNew, proxyActivities } from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';
import { RETRY_SCHEDULED, T_1M, T_10M } from './proxyOptions.js';

/**
 * ReembedMemoryWorkflow — channel assistant admin memory edit-with-reembed.
 *
 * Started BY NAME by the gateway after an admin edits a channel memory item's
 * text (the gateway updates `lesson_summary` / `rationale` synchronously, then
 * kicks this off so the now-stale pgvector embedding is regenerated out of band).
 * Name MUST be `'ReembedMemoryWorkflow'`, task queue `'engineering-workflow'`,
 * single arg `{ memoryId: string }`.
 *
 * V8-isolate rule: only `import type` from external packages / `@auto-swe/shared`;
 * runtime imports come from `@temporalio/workflow` and the activity proxy below.
 */

const { reembedMemoryItemActivity } = proxyActivities<
  Pick<typeof activitiesType, 'reembedMemoryItemActivity'>
>({
  // Embedding-provider calls can fail transiently; a couple of retries is enough.
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_1M,
});

export async function ReembedMemoryWorkflow(input: { memoryId: string }): Promise<void> {
  await reembedMemoryItemActivity(input);
}

const { reembedStaleMemoryBatch } = proxyActivities<
  Pick<typeof activitiesType, 'reembedStaleMemoryBatch'>
>({
  heartbeatTimeout: T_1M,
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_10M,
});

/** Rows per activity call. */
const REEMBED_BATCH_SIZE = 100;
/** Batches per execution before continuing as new, which keeps history bounded. */
const BATCHES_PER_EXECUTION = 50;

export interface ReembedStaleMemoryInput {
  afterId?: string | null;
  reembedded?: number;
  failed?: number;
}

export interface ReembedStaleMemoryResult {
  reembedded: number;
  failed: number;
}

/**
 * ReembedStaleMemoryWorkflow — re-embed every memory row the current embedding
 * model did not produce, after an admin changes that model. Until then those
 * rows are invisible to recall and consolidation, which only compare vectors
 * from one model.
 *
 * Started BY NAME by the gateway (`POST /api/v1/platform/embedding-config/reembed`)
 * under one fixed workflow id, so two cannot run at once. It walks the rows in id
 * order, one batch per activity, and continues as new every
 * {@link BATCHES_PER_EXECUTION} batches carrying the cursor and running totals.
 */
export async function ReembedStaleMemoryWorkflow(
  input: ReembedStaleMemoryInput = {}
): Promise<ReembedStaleMemoryResult> {
  let afterId = input.afterId ?? null;
  let reembedded = input.reembedded ?? 0;
  let failed = input.failed ?? 0;
  for (let i = 0; i < BATCHES_PER_EXECUTION; i++) {
    const batch = await reembedStaleMemoryBatch({ afterId, batchSize: REEMBED_BATCH_SIZE });
    reembedded += batch.reembedded;
    failed += batch.failed;
    if (batch.done) {
      return { failed, reembedded };
    }
    afterId = batch.lastId;
  }
  return continueAsNew<typeof ReembedStaleMemoryWorkflow>({ afterId, failed, reembedded });
}
