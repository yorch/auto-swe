import { prisma } from '@auto-swe/shared/db';

/**
 * Upsert the workflow's current status. Workflows that lack a pre-existing
 * ActiveWorkflow row (e.g. epic-orchestrator workflows, or engineering workflows
 * spawned as children by an epic) self-register on their first state call.
 *
 * The gateway-created row, when present, already has repoId/workRequestId/etc.
 * — those columns are nullable so the create branch leaves them null and they
 * stay null forever for self-registered rows. That's intentional: the epic row
 * doesn't belong to a single repo, and child rows could backfill repoId later
 * via a separate code path if needed.
 */
export async function updateDomainState(temporalWorkflowId: string, status: string): Promise<void> {
  await prisma.activeWorkflow.upsert({
    create: { currentStatus: status, temporalWorkflowId },
    update: { currentStatus: status },
    where: { temporalWorkflowId },
  });
}
