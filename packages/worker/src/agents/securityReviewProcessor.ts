import { Agent } from '@mastra/core/agent';
import { trace } from '@opentelemetry/api';
import { z } from 'zod';
import { getModel, getModelSpec } from '../lib/models.js';
import { SECURITY_REVIEW_PROMPT } from './prompts.js';

const tracer = trace.getTracer('auto-swe-worker');

// ── Zod schemas for structured output ──

const SecurityFindingSchema = z.object({
  category: z.string(),
  description: z.string(),
  file: z.string(),
  line: z.number().optional(),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
  suggestedFix: z.string(),
});

const SecurityScanResultSchema = z.object({
  findings: z.array(SecurityFindingSchema),
  passed: z.boolean(),
});

export type SecurityFinding = z.infer<typeof SecurityFindingSchema>;
export type SecurityScanResult = z.infer<typeof SecurityScanResultSchema>;

// ── Security Review Agent ──

export async function scanDiffForSecurityIssues(diff: string): Promise<SecurityScanResult> {
  return tracer.startActiveSpan(
    'llm.security_scan',
    { attributes: { 'llm.model': getModelSpec('securityReview') } },
    async (span) => {
      try {
        const agent = new Agent({
          id: 'security-review-gate',
          instructions: SECURITY_REVIEW_PROMPT,
          model: getModel('securityReview'),
          name: 'security-review-gate',
        });

        const result = await agent.generate(
          [
            {
              content: diff,
              role: 'user',
            },
          ],
          { structuredOutput: { schema: SecurityScanResultSchema } }
        );

        if (!result.object) {
          throw new Error('Security review agent did not return structured output');
        }
        const scanResult = result.object as SecurityScanResult;

        // Enforce invariant: passed must be false if any CRITICAL finding exists
        const hasCritical = scanResult.findings.some((f) => f.severity === 'CRITICAL');
        return {
          ...scanResult,
          passed: hasCritical ? false : scanResult.passed,
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
