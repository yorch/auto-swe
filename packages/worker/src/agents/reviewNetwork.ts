import type {
  AggregatedReviewResult,
  CodeResult,
  ReviewVerdict,
} from '@auto-swe/shared/types/workflow';
import { Agent } from '@mastra/core/agent';
import { trace } from '@opentelemetry/api';
import { ApplicationFailure } from '@temporalio/activity';
import { z } from 'zod';
import { currentWorkflowId } from '../lib/activityContext.js';
import type { AgentTracer } from '../lib/agentTracer.js';
import { formatCodeSecurityFindings } from '../lib/codeSecurityScanner.js';
import { ConfigMissingError } from '../lib/config/resolver.js';
import { assertBudgetAvailable, type LlmAttribution, recordLlmUsage } from '../lib/costTracking.js';
import { failedCallAttribution } from '../lib/llmAttribution.js';
import { getModel, getModelSpec } from '../lib/models.js';
import { assertRolePricedForUsdCap } from '../lib/usdCapGuard.js';
import {
  DOMAIN_LOGIC_REVIEWER_PROMPT,
  PERFORMANCE_REVIEWER_PROMPT,
  SECURITY_AUDITOR_PROMPT,
} from './prompts.js';

const otelTracer = trace.getTracer('auto-swe-worker');

// ── Zod schemas for structured output ──

const ReviewFindingSchema = z.object({
  category: z.string(),
  description: z.string(),
  file: z.string(),
  line: z.number().optional(),
  suggestedFix: z.string(),
});

const ReviewVerdictSchema = z.object({
  approved: z.boolean(),
  findings: z.array(ReviewFindingSchema),
  reviewer: z.enum(['SECURITY', 'DOMAIN_LOGIC', 'PERFORMANCE']),
  severity: z.enum(['PASS', 'INFO', 'WARNING', 'CRITICAL']),
});

// ── Individual Reviewer Agents ──

/**
 * The Agent row each reviewer persona runs as. Each carries its own prompt and
 * skills, and binds the `reviewer` model through `inheritsModelFrom` unless the
 * row sets a `modelSpec` of its own.
 */
export const REVIEWER_AGENT_KEYS: Record<ReviewVerdict['reviewer'], string> = {
  DOMAIN_LOGIC: 'domainLogicReviewer',
  PERFORMANCE: 'performanceReviewer',
  SECURITY: 'securityReviewer',
};

async function runReviewerAgent(
  prompt: string,
  reviewerType: ReviewVerdict['reviewer'],
  codeResult: CodeResult,
  tracer?: AgentTracer
): Promise<ReviewVerdict> {
  const agentKey = REVIEWER_AGENT_KEYS[reviewerType];
  return otelTracer.startActiveSpan(
    `llm.review.${reviewerType}`,
    { attributes: { 'llm.reviewer_type': reviewerType } },
    async (span) => {
      const start = Date.now();
      let llmUserMessage = '';
      let modelSpec: string | undefined;
      let recorded: LlmAttribution | undefined;
      try {
        modelSpec = await getModelSpec(agentKey);
        const model = await getModel(agentKey);
        span.setAttribute('llm.model', modelSpec);
        const agent = new Agent({
          id: `${reviewerType.toLowerCase()}-reviewer`,
          instructions: prompt,
          model,
          name: `${reviewerType.toLowerCase()}-reviewer`,
        });

        llmUserMessage = JSON.stringify({
          diff: codeResult.diff,
          filesChanged: codeResult.filesChanged,
          implementationNotes: codeResult.implementationNotes,
          testResults: codeResult.testResults,
        });
        const result = await agent.generate([{ content: llmUserMessage, role: 'user' }], {
          structuredOutput: { schema: ReviewVerdictSchema },
        });

        let attribution = { costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 };
        if (result.usage) {
          attribution = recorded = await recordLlmUsage(
            currentWorkflowId(),
            agentKey,
            result.usage,
            `llm.review.${reviewerType.toLowerCase()}`
          );
        }

        // Validate rather than cast: an object that does not match the schema
        // (a missing `findings`, an unknown severity) is no verdict at all.
        const parsed = ReviewVerdictSchema.safeParse(result.object);
        if (!parsed.success) {
          throw new Error(`${reviewerType} reviewer agent did not return valid structured output`);
        }
        const verdict = parsed.data;
        const verdictWithType = {
          ...verdict,
          // A CRITICAL verdict is a rejection whatever `approved` says: the
          // two fields disagreeing must not let a critical finding through.
          approved: verdict.approved && verdict.severity !== 'CRITICAL',
          reviewer: reviewerType,
        };

        tracer?.addLlmResponse({
          costUsd: attribution.costUsd,
          durationMs: Date.now() - start,
          inputJson: { systemPrompt: prompt, userMessage: llmUserMessage },
          inputTokens: attribution.inputTokens,
          model: attribution.modelSpec || undefined,
          outputJson: verdictWithType,
          outputTokens: attribution.outputTokens,
          role: reviewerType,
        });

        return verdictWithType;
      } catch (e) {
        tracer?.addLlmResponse({
          ...failedCallAttribution(e, modelSpec, recorded),
          durationMs: Date.now() - start,
          error: (e as Error).message,
          inputJson: { systemPrompt: prompt, userMessage: llmUserMessage },
          role: reviewerType,
        });
        span.recordException(e as Error);
        throw e;
      } finally {
        span.end();
      }
    }
  );
}

// ── Review Network Orchestrator ──

/**
 * Everything the reviewers need beyond the diff itself. An options object
 * rather than positional parameters: these are five same-typed optional
 * strings, and callers were already threading `undefined, undefined, …` past
 * the ones they did not set to reach the ones they did.
 */
export interface ReviewNetworkOptions {
  /**
   * Cross-repo dependency block (repo dependency graph, P2) — appended to every
   * reviewer's system prompt. All three benefit: a breaking-change judgement
   * needs the consumer list, a security judgement needs to know who is exposed,
   * and a performance judgement needs to know who calls this code.
   */
  crossRepoContext?: string;
  /**
   * Fenced lessons from past runs on this repository, recalled by the change
   * under review — appended to every reviewer's system prompt, so a reviewer
   * knows what earlier reviews of similar changes caught.
   */
  lessonsContext?: string;
  domainSkillSuffix?: string;
  performanceSkillSuffix?: string;
  securitySkillSuffix?: string;
  /**
   * Each persona's base prompt, as the activity chose it
   * (`reviewerPersonaPrompt` in `activities/runReviewNetwork.ts`): the
   * persona's own customised row, else a customised parent `reviewer` row,
   * else the persona's seeded text. Unset falls back to the built-in prompt
   * for that persona. The parent row's seeded text is never used — it is the
   * domain-logic prompt, and handing it to all three made every reviewer
   * review domain logic.
   */
  domainLogicPrompt?: string;
  performancePrompt?: string;
  securityPrompt?: string;
  successCriteria?: string[];
  /**
   * A step-level prompt set by the template author on the review node. It
   * replaces all three personas' base prompts — the author asked for exactly
   * that text — while each keeps its own skills and context suffixes.
   */
  systemPromptOverride?: string;
  tracer?: AgentTracer;
}

export async function runReviewNetwork(
  codeResult: CodeResult,
  options: ReviewNetworkOptions = {}
): Promise<AggregatedReviewResult> {
  const {
    crossRepoContext,
    lessonsContext,
    domainSkillSuffix,
    performanceSkillSuffix,
    securitySkillSuffix,
    successCriteria,
    systemPromptOverride,
    tracer,
  } = options;
  // Append success criteria to the domain logic prompt so it validates against original intent
  let domainLogicPrompt =
    systemPromptOverride || options.domainLogicPrompt || DOMAIN_LOGIC_REVIEWER_PROMPT;
  if (successCriteria && successCriteria.length > 0) {
    domainLogicPrompt += `\n\nSUCCESS CRITERIA FROM ORIGINAL REQUEST:\nThe implementation must satisfy these criteria extracted from the work request:\n${successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nFor each criterion, verify whether the diff satisfies it. Report unmet criteria as findings with category "UNMET_SUCCESS_CRITERION".`;
  }

  // Append per-reviewer skill fragments to each reviewer's prompt.
  if (domainSkillSuffix) {
    domainLogicPrompt += `\n\n${domainSkillSuffix}`;
  }

  // The dependency block already carries its own `\n\n## …` heading (see
  // `lib/repoDependencyContext.ts`); normalize anyway so a hand-built block
  // cannot run into the preceding paragraph.
  const crossRepoSuffix =
    (crossRepoContext
      ? crossRepoContext.startsWith('\n')
        ? crossRepoContext
        : `\n\n${crossRepoContext}`
      : '') + (lessonsContext ?? '');
  domainLogicPrompt += crossRepoSuffix;

  const staticScanSuffix = formatCodeSecurityFindings(codeResult.codeSecurityFindings ?? []);
  const securityPrompt =
    (systemPromptOverride || options.securityPrompt || SECURITY_AUDITOR_PROMPT) +
    (securitySkillSuffix ? `\n\n${securitySkillSuffix}` : '') +
    (staticScanSuffix ? `\n\n${staticScanSuffix}` : '') +
    crossRepoSuffix;
  const performancePrompt =
    (systemPromptOverride || options.performancePrompt || PERFORMANCE_REVIEWER_PROMPT) +
    (performanceSkillSuffix ? `\n\n${performanceSkillSuffix}` : '') +
    crossRepoSuffix;

  // Run all three reviewers in parallel
  // One gate for the fan-out, not one per reviewer. All three start at the same
  // instant, before any has recorded usage, so three concurrent reads of the
  // same row reach the same verdict — the check that matters is the one before
  // the fan-out begins.
  // Before the fan-out, for the same reason: refuse an unpriced reviewer model
  // under a USD cap once, not three times concurrently.
  for (const agentKey of new Set(Object.values(REVIEWER_AGENT_KEYS))) {
    await assertRolePricedForUsdCap(agentKey);
  }
  await assertBudgetAvailable('review');

  const results = await Promise.allSettled([
    runReviewerAgent(securityPrompt, 'SECURITY', codeResult, tracer),
    runReviewerAgent(domainLogicPrompt, 'DOMAIN_LOGIC', codeResult, tracer),
    runReviewerAgent(performancePrompt, 'PERFORMANCE', codeResult, tracer),
  ]);

  // A failure the reviewer cannot recover from on its own is not a verdict on
  // the code: an exhausted budget, a missing config row, an unpriced model.
  // Turning it into a REVIEWER_CRASH rejection would send the change back to
  // the implementer for a review-fix session that changes nothing about the
  // cause, up to the retry limit. Surface it as the activity's failure instead.
  for (const result of results) {
    if (result.status === 'rejected' && isUnrecoverableReviewerFailure(result.reason)) {
      throw result.reason;
    }
  }
  // Every persona failed (a provider outage, typically): there is no review to
  // aggregate. Throw a retryable failure so Temporal retries the activity
  // rather than reporting three synthetic rejections as a review.
  if (results.every((r) => r.status === 'rejected')) {
    const reasons = results.map(
      (r) => (r as PromiseRejectedResult).reason?.message ?? 'Unknown error'
    );
    throw ApplicationFailure.retryable(
      `All reviewers failed: ${reasons.join('; ')}`,
      'REVIEW_NETWORK_UNAVAILABLE'
    );
  }

  const verdicts: ReviewVerdict[] = results.map((result, index) => {
    const reviewerTypes: ReviewVerdict['reviewer'][] = ['SECURITY', 'DOMAIN_LOGIC', 'PERFORMANCE'];
    if (result.status === 'fulfilled') {
      return result.value;
    }
    // Some (not all) reviewers crashed: the rest gave a verdict, so the review
    // stands, and the missing one is a critical finding requiring manual review.
    return {
      approved: false,
      findings: [
        {
          category: 'REVIEWER_CRASH',
          description: `Reviewer agent failed: ${(result as PromiseRejectedResult).reason?.message ?? 'Unknown error'}`,
          file: '',
          suggestedFix: 'Manual review required',
        },
      ],
      reviewer: reviewerTypes[index],
      severity: 'CRITICAL' as const,
    };
  });

  const approved = verdicts.every((v) => v.approved);

  const rejectionSummary = approved ? undefined : summarizeRejections(verdicts);

  return {
    approved,
    codeResult,
    rejectionSummary,
    verdicts,
  };
}

/**
 * A reviewer failure that retrying the review (or fixing the code) cannot
 * cure: a non-retryable `ApplicationFailure` (`BUDGET_EXCEEDED`,
 * `MODEL_UNPRICED`, …) or a missing configuration row.
 */
function isUnrecoverableReviewerFailure(err: unknown): boolean {
  if (err instanceof ConfigMissingError) {
    return true;
  }
  return err instanceof ApplicationFailure && err.nonRetryable === true;
}

/**
 * The feedback a review-fix session starts from: every rejecting reviewer's
 * findings, each with its severity, the problem, and the suggested fix. A
 * rejection with no findings still gets a line, so the fixer is not handed an
 * empty summary for a review that failed.
 */
export function summarizeRejections(verdicts: ReviewVerdict[]): string {
  const lines: string[] = [];
  for (const v of verdicts) {
    if (v.approved) {
      continue;
    }
    if (v.findings.length === 0) {
      lines.push(`[${v.reviewer}/${v.severity}] rejected without findings: ${v.reviewer}`);
      continue;
    }
    for (const f of v.findings) {
      const where = `${f.file}${f.line ? `:${f.line}` : ''}`;
      lines.push(
        `[${v.reviewer}/${v.severity}] [${f.category}] ${where} — ${f.description}` +
          ` — Suggested fix: ${f.suggestedFix}`
      );
    }
  }
  return lines.join('\n');
}
