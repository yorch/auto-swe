import { ReviewLaunchError, reviewFixRetryState } from '@auto-swe/shared/lib/reviewLaunch';
import type { FastifyInstance } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';
import { writeAuditLog } from './auditLog.js';

export async function queueReviewFixRetry(
  app: FastifyInstance,
  user: JwtPayload,
  runId: string,
  expected?: { fireId: string; connectionId: string; automationId: string }
) {
  const state = await reviewFixRetryState(app.prisma, runId);
  if (
    !state.allowed ||
    (expected &&
      (state.fire?.id !== expected.fireId ||
        state.fire.automationId !== expected.automationId ||
        state.payload.connectionId !== expected.connectionId))
  ) {
    throw new ReviewLaunchError(
      'NOT_RETRYABLE',
      state.allowed ? 'The fix decision changed' : state.reason
    );
  }
  const workflowId = `review-fix-retry-${state.attemptId}`;
  await app.temporal.startReviewFixRetry(workflowId, {
    attemptId: state.attemptId,
    runId,
    ...(expected ? { automationId: expected.automationId } : {}),
  });
  if (state.fire) {
    await app.prisma.automationFire.updateMany({
      data: { retriedAt: new Date() },
      where: { id: state.fire.id, outcome: { not: 'STARTED' }, retriedAt: null },
    });
  }
  await writeAuditLog(app, {
    action: 'UPDATE',
    actor: user,
    after: { fixRetryWorkflowId: workflowId },
    entityId: runId,
    entityType: 'WorkflowRun',
  });
  return { workflowId };
}
