import { prisma } from '@auto-swe/shared/db';
import { isAttachRequestPending } from '@auto-swe/shared/lib/orchestration';

/**
 * Small reads of an orchestration's live state, shared by the turn, apply and refresh activities.
 */

export const RUNNING_CHILD_STATUSES = ['STARTING', 'RUNNING'] as const;

export async function countOrchestrationLoad(
  orchestrationId: string
): Promise<{ runningChildren: number; pendingApprovals: number }> {
  const [runningChildren, pendingApprovals] = await Promise.all([
    prisma.orchestrationChild.count({
      where: { orchestrationId, status: { in: [...RUNNING_CHILD_STATUSES] } },
    }),
    prisma.orchestrationApproval.count({ where: { orchestrationId, status: 'PENDING' } }),
  ]);
  return { pendingApprovals, runningChildren };
}

/**
 * Whether a repository request is waiting for the launcher: the LATEST `ATTACH_REQUEST` message
 * has no `payload.resolution`. The gateway's attach and decline routes set it, and read the
 * request the same way (`isAttachRequestPending`), so once a request is resolved the
 * orchestrator can ask again.
 */
export async function hasPendingAttach(orchestrationId: string): Promise<boolean> {
  const row = await prisma.orchestrationMessage.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { payload: true },
    where: { kind: 'ATTACH_REQUEST', orchestrationId },
  });
  return row !== null && isAttachRequestPending(row.payload);
}

/** A SYSTEM notice the next orchestrator turn will read. */
export async function writeNotice(
  orchestrationId: string,
  code: string,
  body: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await prisma.orchestrationMessage.create({
    data: {
      body: body.slice(0, 2000),
      kind: 'NOTICE',
      orchestrationId,
      payload: { ...extra, code },
      role: 'SYSTEM',
    },
  });
}
