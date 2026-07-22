import { proxyActivities } from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';
import { RETRY_SCHEDULED, T_1M } from './proxyOptions.js';

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
