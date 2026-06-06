import type { AggregatedReviewResult, CodeResult } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { runReviewNetwork as runReview } from '../agents/reviewNetwork.js';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { loadAgentSkills, type ResolvedSkill } from '../lib/config/agentSkills.js';
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

  // Resolve DB-level prompt and per-sub-role skills for the reviewer role.
  const ctx = await currentRequestContext();
  const [modelConfig, securitySkills, domainSkills, performanceSkills] = await Promise.all([
    resolveModelConfig('reviewer', ctx),
    loadAgentSkills('securityReviewer', ctx),
    loadAgentSkills('domainLogicReviewer', ctx),
    loadAgentSkills('performanceReviewer', ctx),
  ]);
  const dbPrompt = modelConfig.systemPrompt ?? undefined;

  const toSuffix = (skills: ResolvedSkill[]) =>
    skills
      .map((s) => s.promptText)
      .filter(Boolean)
      .join('\n\n') || undefined;

  const result = await runReview(
    codeResult,
    successCriteria,
    tracer,
    systemPromptOverride ?? dbPrompt,
    toSuffix(securitySkills),
    toSuffix(domainSkills),
    toSuffix(performanceSkills)
  );

  heartbeat(`review complete: ${result.approved ? 'approved' : 'rejected'}`);

  await persistActivityTrace(tracer, 'reviewer');

  return result;
}
