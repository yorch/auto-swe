import { prisma } from '@auto-swe/shared/db';
import { AGENT_RUN_TEMPLATE_ORIGIN, AgentRunPayloadSchema } from '@auto-swe/shared/lib/agentRun';
import { ApplicationFailure } from '@temporalio/activity';
import { z } from 'zod';
import { readReviewFeedback } from './reviewFeedback.js';

const Result = z.object({
  baseSha: z.string().optional(),
  deliver: z.literal('none'),
  diff: z.string(),
  diffTruncated: z.boolean().optional(),
});

export async function loadStoredAgentChange(sourceRunId: string, repoId: string) {
  const source = await prisma.workflowRun.findUnique({
    include: {
      steps: {
        orderBy: { endedAt: 'desc' },
        take: 1,
        where: { status: 'PASSED', stepName: 'runAgentTask' },
      },
      template: { select: { origin: true, teamId: true } },
      workRequest: { select: { connectionId: true, description: true, payload: true } },
    },
    where: { id: sourceRunId },
  });
  if (
    !source?.endedAt ||
    source.reviewOfRunId ||
    source.template.teamId !== null ||
    source.template.origin !== AGENT_RUN_TEMPLATE_ORIGIN ||
    (source.connectionId ?? source.workRequest?.connectionId) !== repoId
  ) {
    throw ApplicationFailure.nonRetryable(
      'Source is not a finished agent run on this repository',
      'REVIEW_NOTHING_TO_REVIEW'
    );
  }
  const snapshot = source.contextSnapshot as { result?: unknown } | null;
  const parsed = Result.safeParse(snapshot?.result ?? source.steps[0]?.outputs);
  if (!parsed.success || !parsed.data.diff.trim()) {
    throw ApplicationFailure.nonRetryable(
      'Source has no stored agent diff',
      'REVIEW_NOTHING_TO_REVIEW'
    );
  }
  if (parsed.data.diffTruncated) {
    throw ApplicationFailure.nonRetryable(
      'The source agent diff was truncated',
      'REVIEW_DIFF_TOO_LARGE'
    );
  }
  const payload = AgentRunPayloadSchema.safeParse(source.workRequest?.payload);
  return {
    ...parsed.data,
    agentPayload: payload.success && payload.data.deliver === 'none' ? payload.data : undefined,
    baseBranch: payload.success ? payload.data.baseBranch : undefined,
    description: source.workRequest?.description ?? '',
    launchedById: source.launchedById,
  };
}

export async function storedFixInput(reviewRunId: string, repoId: string, agentRef: string) {
  let review = await readReviewFeedback(reviewRunId, repoId);
  const deadline = Date.now() + 5 * 60_000;
  while (review?.status === 'RUNNING' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    review = await readReviewFeedback(reviewRunId, repoId);
  }
  if (review?.status !== 'SUCCESS' || review.approved !== false || review.origin !== 'agent_run') {
    throw ApplicationFailure.nonRetryable(
      'The stored review did not succeed with blocking findings',
      'REVIEW_FIX_INVALID'
    );
  }
  const source = await loadStoredAgentChange(review.sourceRunId, repoId);
  if (
    !source.baseSha ||
    !source.agentPayload ||
    source.agentPayload.agentRef !== agentRef ||
    review.storedChange?.baseSha !== source.baseSha ||
    review.storedChange.diff !== source.diff
  ) {
    throw ApplicationFailure.nonRetryable(
      'The stored fix does not match the reviewed source and agent',
      'REVIEW_FIX_INVALID'
    );
  }
  return { baseSha: source.baseSha, diff: source.diff };
}
