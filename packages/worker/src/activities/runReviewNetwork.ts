import type { AggregatedReviewResult, CodeResult } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { runReviewNetwork as runReview } from '../agents/reviewNetwork.js';
import { currentActivityType, currentWorkflowRunId } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';

/**
 * Runs the review network (Security Auditor, Domain Logic, Performance Reviewer)
 * in parallel and aggregates their verdicts.
 */
export async function runReviewNetwork(
  codeResult: CodeResult,
  successCriteria?: string[]
): Promise<AggregatedReviewResult> {
  heartbeat('starting review network');
  const tracer = new AgentTracer();

  const result = await runReview(codeResult, successCriteria, tracer);

  heartbeat(`review complete: ${result.approved ? 'approved' : 'rejected'}`);

  await tracer.persist(await currentWorkflowRunId(), currentActivityType(), 'reviewer');

  return result;
}
