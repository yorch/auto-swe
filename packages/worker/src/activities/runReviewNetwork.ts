import type { AggregatedReviewResult, CodeResult } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { runReviewNetwork as runReview } from '../agents/reviewNetwork.js';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { resolveModelConfig } from '../lib/config/resolver.js';

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

  // Resolve DB-level prompt for the reviewer role. When undefined, each
  // reviewer agent falls back to its own hardcoded default (security/domain/perf).
  const ctx = await currentRequestContext();
  const dbPrompt = (await resolveModelConfig('reviewer', ctx)).systemPrompt ?? undefined;
  const result = await runReview(
    codeResult,
    successCriteria,
    tracer,
    systemPromptOverride ?? dbPrompt
  );

  heartbeat(`review complete: ${result.approved ? 'approved' : 'rejected'}`);

  await persistActivityTrace(tracer, 'reviewer');

  return result;
}
