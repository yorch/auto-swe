import type { AggregatedReviewResult, CodeResult } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { runReviewNetwork as runReview } from '../agents/reviewNetwork.js';
import { currentWorkflowRunId, persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { resolveAgent } from '../lib/config/agentResolver.js';
import { skillsToPromptSuffix } from '../lib/config/agentSkills.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { recordReviewEval } from '../lib/evalCapture.js';

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

  // Resolve the reviewer Agent (for the shared base prompt) and each
  // sub-reviewer Agent by key (each inherits the reviewer model via
  // inheritsModelFrom and carries its own skills). With null-overlay seeded
  // agents this is byte-identical to the legacy reviewer-model + per-sub-role
  // skill resolution.
  const ctx = await currentRequestContext();
  const [reviewerAgent, securityAgent, domainAgent, performanceAgent] = await Promise.all([
    resolveAgent('reviewer', ctx),
    resolveAgent('securityReviewer', ctx),
    resolveAgent('domainLogicReviewer', ctx),
    resolveAgent('performanceReviewer', ctx),
  ]);
  const dbPrompt = reviewerAgent.model.systemPrompt ?? undefined;

  try {
    const result = await runReview(
      codeResult,
      successCriteria,
      tracer,
      systemPromptOverride ?? dbPrompt,
      skillsToPromptSuffix(securityAgent.skills),
      skillsToPromptSuffix(domainAgent.skills),
      skillsToPromptSuffix(performanceAgent.skills)
    );

    heartbeat(`review complete: ${result.approved ? 'approved' : 'rejected'}`);

    // P0 evals: capture each reviewer verdict as a normalized signal (best-effort).
    await recordReviewEval(result.verdicts, await currentWorkflowRunId());

    return result;
  } finally {
    await persistActivityTrace(tracer, 'reviewer');
  }
}
