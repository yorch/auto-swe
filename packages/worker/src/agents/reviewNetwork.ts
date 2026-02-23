import { Agent } from '@mastra/core';
import { anthropic } from '@ai-sdk/anthropic';
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
  const agent = new Agent({
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

  const verdict = result.object as z.infer<typeof ReviewVerdictSchema>;

  return {
    ...verdict,
    reviewer: reviewerType,
  };
}

// ── Review Network Orchestrator ──

export async function runReviewNetwork(
  codeResult: CodeResult,
): Promise<AggregatedReviewResult> {
  // Run all three reviewers in parallel
  const results = await Promise.allSettled([
    runReviewerAgent(SECURITY_AUDITOR_PROMPT, 'SECURITY', codeResult),
    runReviewerAgent(DOMAIN_LOGIC_REVIEWER_PROMPT, 'DOMAIN_LOGIC', codeResult),
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
