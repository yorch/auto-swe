import type { AggregatedReviewResult, CodeResult } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { runReviewNetwork as runReview } from '../agents/reviewNetwork.js';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { loadAgentSkills } from '../lib/config/agentSkills.js';
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

  // Resolve DB-level prompt and skills for the reviewer role.
  const ctx = await currentRequestContext();
  const [modelConfig, skills] = await Promise.all([
    resolveModelConfig('reviewer', ctx),
    loadAgentSkills('reviewer', ctx),
  ]);
  const dbPrompt = modelConfig.systemPrompt ?? undefined;
  const skillSuffix = skills
    .map((s) => s.promptText)
    .filter(Boolean)
    .join('\n\n');
  const result = await runReview(
    codeResult,
    successCriteria,
    tracer,
    systemPromptOverride ?? dbPrompt,
    skillSuffix || undefined
  );

  heartbeat(`review complete: ${result.approved ? 'approved' : 'rejected'}`);

  await persistActivityTrace(tracer, 'reviewer');

  return result;
}
