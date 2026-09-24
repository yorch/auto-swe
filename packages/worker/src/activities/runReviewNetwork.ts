import type { AggregatedReviewResult, CodeResult } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import {
  DOMAIN_LOGIC_REVIEWER_PROMPT,
  PERFORMANCE_REVIEWER_PROMPT,
  SECURITY_AUDITOR_PROMPT,
} from '../agents/prompts.js';
import { REVIEWER_AGENT_KEYS, runReviewNetwork as runReview } from '../agents/reviewNetwork.js';
import { currentWorkflowRunId, persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { resolveAgent } from '../lib/config/agentResolver.js';
import { skillsToPromptSuffix } from '../lib/config/agentSkills.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { recordReviewEval } from '../lib/evalCapture.js';
import { withHeartbeat } from '../lib/execUtils.js';
import {
  type CrossRepoStepOptions,
  loadRepoDependencyContext,
  wantsCrossRepoContext,
} from '../lib/repoDependencyContext.js';

/** Two prompts are the same text if they differ only in surrounding whitespace. */
function samePrompt(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

function nonEmpty(value: string | undefined | null): string | undefined {
  return value?.trim() ? value : undefined;
}

/**
 * The parent `reviewer` row's prompt, when an admin has customised it — and
 * `undefined` when it still holds the seeded domain-logic text. Before the
 * personas resolved their own rows, that parent prompt was the one all three
 * reviewers ran with, so a deployment that edited it expects the edit to keep
 * applying. The seeded text is recognised either as the built-in constant or
 * as the `domainLogicReviewer` row's text, which was seeded from the same
 * constant and so matches even after a later release rewords it.
 */
export function customisedReviewerPrompt(
  reviewerRowPrompt: string | undefined,
  domainRowPrompt: string | undefined
): string | undefined {
  const parent = nonEmpty(reviewerRowPrompt);
  if (!parent || samePrompt(parent, DOMAIN_LOGIC_REVIEWER_PROMPT)) {
    return undefined;
  }
  const domain = nonEmpty(domainRowPrompt);
  if (domain && samePrompt(parent, domain)) {
    return undefined;
  }
  return parent;
}

/**
 * One persona's base prompt. Most specific first: the persona's own row when
 * an admin customised it (it differs from the persona's built-in prompt), then
 * a customised parent `reviewer` prompt, then the persona row's seeded text,
 * then the built-in constant. The step-level override outranks all of these
 * and is applied inside the review network itself.
 */
export function reviewerPersonaPrompt(
  personaRowPrompt: string | undefined,
  builtinPrompt: string,
  customisedParentPrompt: string | undefined
): string {
  const own = nonEmpty(personaRowPrompt);
  if (own && !samePrompt(own, builtinPrompt)) {
    return own;
  }
  return customisedParentPrompt ?? own ?? builtinPrompt;
}

/**
 * Runs the review network (Security Auditor, Domain Logic, Performance Reviewer)
 * in parallel and aggregates their verdicts.
 */
export async function runReviewNetwork(
  codeResult: CodeResult,
  successCriteria?: string[],
  systemPromptOverride?: string,
  options?: CrossRepoStepOptions
): Promise<AggregatedReviewResult> {
  // Heartbeats while the whole activity runs: its LLM call can outlast the
  // heartbeat timeout, and a heartbeat is how a cancellation reaches it.
  return withHeartbeat(
    'runReviewNetwork',
    runReviewNetworkImpl(codeResult, successCriteria, systemPromptOverride, options)
  );
}

async function runReviewNetworkImpl(
  codeResult: CodeResult,
  successCriteria?: string[],
  systemPromptOverride?: string,
  options?: CrossRepoStepOptions
): Promise<AggregatedReviewResult> {
  heartbeat('starting review network');
  const tracer = new AgentTracer();

  // Resolve each sub-reviewer Agent by its own key: its prompt and skills are
  // its own, and it inherits the reviewer model via inheritsModelFrom. The
  // parent `reviewer` row's prompt applies only when an admin customised it
  // (see `reviewerPersonaPrompt`): it is seeded with the domain-logic prompt,
  // and passing that to all three personas made the security and performance
  // reviewers review domain logic.
  const ctx = await currentRequestContext();
  const [securityAgent, domainAgent, performanceAgent, reviewerAgent] = await Promise.all([
    resolveAgent(REVIEWER_AGENT_KEYS.SECURITY, ctx),
    resolveAgent(REVIEWER_AGENT_KEYS.DOMAIN_LOGIC, ctx),
    resolveAgent(REVIEWER_AGENT_KEYS.PERFORMANCE, ctx),
    // Only its prompt is read; the personas already resolved its model.
    resolveAgent('reviewer', ctx).catch(() => null),
  ]);
  const parentPrompt = customisedReviewerPrompt(
    reviewerAgent?.model.systemPrompt,
    domainAgent.model.systemPrompt
  );

  // Cross-repo dependency context (repo dependency graph, P2) — the reviewers'
  // primary consumer: a breaking-change verdict needs the downstream list.
  // Best-effort by construction; `loadRepoDependencyContext` never throws.
  const crossRepoContext = wantsCrossRepoContext(options)
    ? await loadRepoDependencyContext(codeResult.repoId, ctx.orgId)
    : '';
  if (crossRepoContext) {
    tracer.addActivityEvent({
      name: 'crossRepo.context_loaded',
      outputJson: { chars: crossRepoContext.length },
    });
  }

  try {
    const result = await runReview(codeResult, {
      crossRepoContext: crossRepoContext || undefined,
      domainLogicPrompt: reviewerPersonaPrompt(
        domainAgent.model.systemPrompt,
        DOMAIN_LOGIC_REVIEWER_PROMPT,
        parentPrompt
      ),
      domainSkillSuffix: skillsToPromptSuffix(domainAgent.skills),
      performancePrompt: reviewerPersonaPrompt(
        performanceAgent.model.systemPrompt,
        PERFORMANCE_REVIEWER_PROMPT,
        parentPrompt
      ),
      performanceSkillSuffix: skillsToPromptSuffix(performanceAgent.skills),
      securityPrompt: reviewerPersonaPrompt(
        securityAgent.model.systemPrompt,
        SECURITY_AUDITOR_PROMPT,
        parentPrompt
      ),
      securitySkillSuffix: skillsToPromptSuffix(securityAgent.skills),
      successCriteria,
      systemPromptOverride,
      tracer,
    });

    heartbeat(`review complete: ${result.approved ? 'approved' : 'rejected'}`);

    // P0 evals: capture each reviewer verdict as a normalized signal (best-effort).
    await recordReviewEval(result.verdicts, await currentWorkflowRunId());

    return result;
  } finally {
    await persistActivityTrace(tracer, 'reviewer');
  }
}
