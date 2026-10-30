import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { PRUNE_BATCH, PRUNE_MAX_BATCHES } from './pruneAutomationDecisions.js';

export async function pruneWorkflowHttpCalls(now: Date): Promise<number> {
  return runUnscoped(
    'HTTP retention sweep deletes expired exchanges',
    ['WorkflowHttpCall'],
    async () => {
      const days = await resolveSetting('workflow.httpCaptureRetentionDays', {});
      const cutoff = new Date(now.getTime() - days * 86400000);
      let deleted = 0;
      for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
        const rows = await prisma.workflowHttpCall.findMany({
          orderBy: { createdAt: 'asc' },
          select: { id: true },
          take: PRUNE_BATCH,
          where: { createdAt: { lt: cutoff } },
        });
        if (!rows.length) {
          break;
        }
        const result = await prisma.workflowHttpCall.deleteMany({
          where: { id: { in: rows.map((row) => row.id) } },
        });
        deleted += result.count;
        if (rows.length < PRUNE_BATCH) {
          break;
        }
      }
      return deleted;
    }
  );
}
