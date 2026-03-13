import { Agent } from '@mastra/core';
import { anthropic } from '@ai-sdk/anthropic';
import { trace } from '@opentelemetry/api';
import { activityInfo } from '@temporalio/activity';
import { z } from 'zod';
import type {
  CodeResult,
  ReviewVerdict,
  ReviewFinding,
  AggregatedReviewResult,
} from '@auto-swe/shared/types/workflow';
import {
  SECURITY_AUDITOR_PROMPT,
  DOMAIN_LOGIC_REVIEWER_PROMPT,
  PERFORMANCE_REVIEWER_PROMPT,
} from './prompts.js';
import { recordLlmUsage } from '../lib/costTracking.js';

const tracer = trace.getTracer('auto-swe-worker');

// ── Zod schemas for structured output ──

const ReviewFindingSchema = z.object({
  file: z.string(),
  line: z.number().optional(),
  category: z.string(),
  description: z.string(),
  suggestedFix: z.string(),
});

const ReviewVerdictSchema = z.object({
  reviewer: z.enum(['SECURITY', 'DOMAIN_LOGIC', 'PERFORMANCE']),
  approved: z.boolean(),
  severity: z.enum(['PASS', 'INFO', 'WARNING', 'CRITICAL']),
  findings: z.array(ReviewFindingSchema),
});

// ── Individual Reviewer Agents ──

async function runReviewerAgent(
  prompt: string,
  reviewerType: ReviewVerdict['reviewer'],
  codeResult: CodeResult,
): Promise<ReviewVerdict> {
  return tracer.startActiveSpan(
    `llm.review.${reviewerType}`,
    { attributes: { 'llm.model': 'claude-opus-4-6', 'llm.reviewer_type': reviewerType } },
    async (span) => {
      try {
        const agent = new Agent({
          id: `${reviewerType.toLowerCase()}-reviewer`,
          name: `${reviewerType.toLowerCase()}-reviewer`,
          model: anthropic('claude-opus-4-6'),
          instructions: prompt,
        });

        const result = await agent.generate(
          [
            {
              role: 'user',
              content: JSON.stringify({
                diff: codeResult.diff,
                filesChanged: codeResult.filesChanged,
                testResults: codeResult.testResults,
                implementationNotes: codeResult.implementationNotes,
              }),
            },
          ],
          { output: ReviewVerdictSchema },
        );

        if (result.usage) {
          await recordLlmUsage(
            activityInfo().workflowId,
            result.usage,
            `llm.review.${reviewerType.toLowerCase()}`,
          );
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
    },
  );
}

// ── Review Network Orchestrator ──

export async function runReviewNetwork(
  codeResult: CodeResult,
  successCriteria?: string[],
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
      reviewer: reviewerTypes[index],
      approved: false,
      severity: 'CRITICAL' as const,
      findings: [{
        file: '',
        category: 'REVIEWER_CRASH',
        description: `Reviewer agent failed: ${(result as PromiseRejectedResult).reason?.message ?? 'Unknown error'}`,
        suggestedFix: 'Manual review required',
      }],
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
    verdicts,
    codeResult,
    rejectionSummary,
  };
}
