import { executeChild, proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/knowledgeBases.js';
import { RETRY_SCHEDULED } from './proxyOptions.js';

const { indexKnowledgeBaseSnapshot } = proxyActivities<
  Pick<typeof activities, 'indexKnowledgeBaseSnapshot'>
>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: '30 minutes',
});
const { getKnowledgeBasesForSync } = proxyActivities<
  Pick<typeof activities, 'getKnowledgeBasesForSync'>
>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: '2 minutes',
});

export async function IndexKnowledgeBaseWorkflow(input: {
  knowledgeBaseId: string;
  sha?: string;
}): Promise<void> {
  await indexKnowledgeBaseSnapshot(input.knowledgeBaseId, input.sha);
}

export async function ScheduledKnowledgeBaseSyncWorkflow(): Promise<{
  indexed: number;
  failed: number;
}> {
  const ids = await getKnowledgeBasesForSync();
  let indexed = 0;
  let failed = 0;
  for (const knowledgeBaseId of ids) {
    try {
      await executeChild(IndexKnowledgeBaseWorkflow, {
        args: [{ knowledgeBaseId }],
        workflowId: `knowledge-base-index-${knowledgeBaseId}`,
      });
      indexed++;
    } catch {
      failed++;
    }
  }
  return { failed, indexed };
}
