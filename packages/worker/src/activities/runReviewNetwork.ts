import type { AggregatedReviewResult, CodeResult } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { runReviewNetwork as runReview } from '../agents/reviewNetwork.js';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { resolveSystemPrompt } from '../lib/models.js';

/**
 * Runs the review network (Security Auditor, Domain Logic, Performance Reviewer)
 * in parallel and aggregates their verdicts.
 */
export async function runReviewNetwork(
  codeResult: CodeResult,
  successCriteria?: string[],
  systemPromptOverride?: string
): Promise<AggregatedReviewResult> {
  heartbeat('starting review network');
  const tracer = new AgentTracer();

  const resolvedPrompt = await resolveSystemPrompt('reviewer', '', systemPromptOverride);
  const result = await runReview(codeResult, successCriteria, tracer, resolvedPrompt || undefined);

  heartbeat(`review complete: ${result.approved ? 'approved' : 'rejected'}`);

  await persistActivityTrace(tracer, 'reviewer');

  return result;
}
