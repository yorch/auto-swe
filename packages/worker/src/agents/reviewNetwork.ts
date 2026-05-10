import type {
  AggregatedReviewResult,
  CodeResult,
  ReviewVerdict,
} from '@auto-swe/shared/types/workflow';
import { Agent } from '@mastra/core/agent';
import { trace } from '@opentelemetry/api';
import { z } from 'zod';
import { currentWorkflowId } from '../lib/activityContext.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { getModel, getModelSpec } from '../lib/models.js';
import {
  DOMAIN_LOGIC_REVIEWER_PROMPT,
  PERFORMANCE_REVIEWER_PROMPT,
  SECURITY_AUDITOR_PROMPT,
} from './prompts.js';

const tracer = trace.getTracer('auto-swe-worker');

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
  codeResult: CodeResult
): Promise<ReviewVerdict> {
  return tracer.startActiveSpan(
    `llm.review.${reviewerType}`,
    { attributes: { 'llm.model': getModelSpec('reviewer'), 'llm.reviewer_type': reviewerType } },
    async (span) => {
      try {
        const agent = new Agent({
          id: `${reviewerType.toLowerCase()}-reviewer`,
          instructions: prompt,
          model: getModel('reviewer'),
          name: `${reviewerType.toLowerCase()}-reviewer`,
        });

        const result = await agent.generate(
          [
            {
              content: JSON.stringify({
                diff: codeResult.diff,
                filesChanged: codeResult.filesChanged,
                implementationNotes: codeResult.implementationNotes,
                testResults: codeResult.testResults,
              }),
              role: 'user',
            },
          ],
          { structuredOutput: { schema: ReviewVerdictSchema } }
        );

        if (result.usage) {
          await recordLlmUsage(
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

        return {
          ...verdict,
          reviewer: reviewerType,
        };
      } catch (e) {
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
  successCriteria?: string[]
): Promise<AggregatedReviewResult> {
  // Append success criteria to the domain logic prompt so it validates against original intent
  let domainLogicPrompt = DOMAIN_LOGIC_REVIEWER_PROMPT;
  if (successCriteria && successCriteria.length > 0) {
    domainLogicPrompt += `\n\nSUCCESS CRITERIA FROM ORIGINAL REQUEST:\nThe implementation must satisfy these criteria extracted from the work request:\n${successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nFor each criterion, verify whether the diff satisfies it. Report unmet criteria as findings with category "UNMET_SUCCESS_CRITERION".`;
  }

  // Run all three reviewers in parallel
  const results = await Promise.allSettled([
    runReviewerAgent(SECURITY_AUDITOR_PROMPT, 'SECURITY', codeResult),
    runReviewerAgent(domainLogicPrompt, 'DOMAIN_LOGIC', codeResult),
    runReviewerAgent(PERFORMANCE_REVIEWER_PROMPT, 'PERFORMANCE', codeResult),
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
