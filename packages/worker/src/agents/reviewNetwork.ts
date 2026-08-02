import type {
  AggregatedReviewResult,
  CodeResult,
  ReviewVerdict,
} from '@auto-swe/shared/types/workflow';
import { Agent } from '@mastra/core/agent';
import { trace } from '@opentelemetry/api';
import { z } from 'zod';
import { currentWorkflowId } from '../lib/activityContext.js';
import type { AgentTracer } from '../lib/agentTracer.js';
import { formatCodeSecurityFindings } from '../lib/codeSecurityScanner.js';
import { assertBudgetAvailable, recordLlmUsage } from '../lib/costTracking.js';
import { getModel, getModelSpec } from '../lib/models.js';
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

async function runReviewerAgent(
  prompt: string,
  reviewerType: ReviewVerdict['reviewer'],
  codeResult: CodeResult,
  tracer?: AgentTracer
): Promise<ReviewVerdict> {
  return otelTracer.startActiveSpan(
    `llm.review.${reviewerType}`,
    { attributes: { 'llm.reviewer_type': reviewerType } },
    async (span) => {
      const start = Date.now();
      let llmUserMessage = '';
      try {
        const modelSpec = await getModelSpec('reviewer');
        const model = await getModel('reviewer');
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
        await assertBudgetAvailable(currentWorkflowId(), `review.${reviewerType.toLowerCase()}`);
        const result = await agent.generate([{ content: llmUserMessage, role: 'user' }], {
          structuredOutput: { schema: ReviewVerdictSchema },
        });

        let attribution = { costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 };
        if (result.usage) {
          attribution = await recordLlmUsage(
            currentWorkflowId(),
            'reviewer',
            result.usage,
            `llm.review.${reviewerType.toLowerCase()}`
          );
        }

        if (!result.object) {
          throw new Error(`${reviewerType} reviewer agent did not return structured output`);
        }
        const verdict = result.object as z.infer<typeof ReviewVerdictSchema>;
        const verdictWithType = { ...verdict, reviewer: reviewerType };

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

export async function runReviewNetwork(
  codeResult: CodeResult,
  successCriteria?: string[],
  tracer?: AgentTracer,
  systemPromptOverride?: string,
  securitySkillSuffix?: string,
  domainSkillSuffix?: string,
  performanceSkillSuffix?: string
): Promise<AggregatedReviewResult> {
  // Append success criteria to the domain logic prompt so it validates against original intent
  let domainLogicPrompt = systemPromptOverride ?? DOMAIN_LOGIC_REVIEWER_PROMPT;
  if (successCriteria && successCriteria.length > 0) {
    domainLogicPrompt += `\n\nSUCCESS CRITERIA FROM ORIGINAL REQUEST:\nThe implementation must satisfy these criteria extracted from the work request:\n${successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nFor each criterion, verify whether the diff satisfies it. Report unmet criteria as findings with category "UNMET_SUCCESS_CRITERION".`;
  }

  // Append per-reviewer skill fragments to each reviewer's prompt.
  if (domainSkillSuffix) {
    domainLogicPrompt += `\n\n${domainSkillSuffix}`;
  }

  const staticScanSuffix = formatCodeSecurityFindings(codeResult.codeSecurityFindings ?? []);
  const securityPrompt =
    (systemPromptOverride ?? SECURITY_AUDITOR_PROMPT) +
    (securitySkillSuffix ? `\n\n${securitySkillSuffix}` : '') +
    (staticScanSuffix ? `\n\n${staticScanSuffix}` : '');
  const performancePrompt =
    (systemPromptOverride ?? PERFORMANCE_REVIEWER_PROMPT) +
    (performanceSkillSuffix ? `\n\n${performanceSkillSuffix}` : '');

  // Run all three reviewers in parallel
  const results = await Promise.allSettled([
    runReviewerAgent(securityPrompt, 'SECURITY', codeResult, tracer),
    runReviewerAgent(domainLogicPrompt, 'DOMAIN_LOGIC', codeResult, tracer),
    runReviewerAgent(performancePrompt, 'PERFORMANCE', codeResult, tracer),
  ]);

  const verdicts: ReviewVerdict[] = results.map((result, index) => {
    const reviewerTypes: ReviewVerdict['reviewer'][] = ['SECURITY', 'DOMAIN_LOGIC', 'PERFORMANCE'];
    if (result.status === 'fulfilled') {
      return result.value;
    }
    // If a reviewer crashes, treat as a critical finding requiring manual review
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

  const rejectionSummary = approved
    ? undefined
    : verdicts
        .filter((v) => !v.approved)
        .flatMap((v) => v.findings)
        .map((f) => `[${f.category}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.suggestedFix}`)
        .join('\n');

  return {
    approved,
    codeResult,
    rejectionSummary,
    verdicts,
  };
}
