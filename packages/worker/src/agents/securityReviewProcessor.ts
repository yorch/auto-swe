import { Agent } from '@mastra/core';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { SECURITY_REVIEW_PROMPT } from './prompts.js';

// ── Zod schemas for structured output ──

const SecurityFindingSchema = z.object({
  file: z.string(),
  line: z.number().optional(),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
  category: z.string(),
  description: z.string(),
  suggestedFix: z.string(),
});

const SecurityScanResultSchema = z.object({
  findings: z.array(SecurityFindingSchema),
  passed: z.boolean(),
});

export type SecurityFinding = z.infer<typeof SecurityFindingSchema>;
export type SecurityScanResult = z.infer<typeof SecurityScanResultSchema>;

// ── Security Review Agent ──

export async function scanDiffForSecurityIssues(
  diff: string,
): Promise<SecurityScanResult> {
  const agent = new Agent({
    id: 'security-review-gate',
    name: 'security-review-gate',
    model: anthropic('claude-sonnet-4-20250514'),
    instructions: SECURITY_REVIEW_PROMPT,
  });

  const result = await agent.generate(
    [
      {
        role: 'user',
        content: diff,
      },
    ],
    { output: SecurityScanResultSchema },
  );

  const scanResult = result.object as SecurityScanResult;

  // Enforce invariant: passed must be false if any CRITICAL finding exists
  const hasCritical = scanResult.findings.some((f) => f.severity === 'CRITICAL');
  return {
    ...scanResult,
    passed: hasCritical ? false : scanResult.passed,
  };
}
