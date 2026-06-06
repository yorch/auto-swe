import { Agent } from '@mastra/core/agent';
import { trace } from '@opentelemetry/api';
import { z } from 'zod';
import {
  currentActivityType,
  currentAttempt,
  currentWorkflowId,
  currentWorkflowRunId,
} from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { loadAgentSkills } from '../lib/config/agentSkills.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { getModel, getModelSpec } from '../lib/models.js';
import { SECURITY_REVIEW_PROMPT } from './prompts.js';

const otelTracer = trace.getTracer('auto-swe-worker');

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
  const activityCtx = await currentRequestContext();
  const skills = await loadAgentSkills('securityReview', activityCtx);
  const skillSuffix = skills
    .map((s) => s.promptText)
    .filter(Boolean)
    .join('\n\n');
  const instructions = skillSuffix
    ? `${SECURITY_REVIEW_PROMPT}\n\n${skillSuffix}`
    : SECURITY_REVIEW_PROMPT;

  return otelTracer.startActiveSpan('llm.security_scan', async (span) => {
    const tracer = new AgentTracer();
    const start = Date.now();
    try {
      const modelSpec = await getModelSpec('securityReview');
      const model = await getModel('securityReview');
      span.setAttribute('llm.model', modelSpec);
      const agent = new Agent({
        id: 'security-review-gate',
        instructions,
        model,
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

      if (result.usage) {
        await recordLlmUsage(
          currentWorkflowId(),
          'securityReview',
          result.usage,
          'llm.security_scan'
        );
      }

      if (!result.object) {
        throw new Error('Security review agent did not return structured output');
      }
      const scanResult = result.object as SecurityScanResult;

      // Enforce invariant: passed must be false if any CRITICAL finding exists
      const hasCritical = scanResult.findings.some((f) => f.severity === 'CRITICAL');
      const finalResult = {
        ...scanResult,
        passed: hasCritical ? false : scanResult.passed,
      };

      tracer.addLlmResponse({
        durationMs: Date.now() - start,
        outputJson: {
          findings: finalResult.findings,
          findingsCount: finalResult.findings.length,
          passed: finalResult.passed,
        },
        role: 'securityReview',
      });

      return finalResult;
    } catch (e) {
      tracer.addLlmResponse({
        durationMs: Date.now() - start,
        error: (e as Error).message,
        role: 'securityReview',
      });
      span.recordException(e as Error);
      throw e;
    } finally {
      span.end();
      await tracer.persist(
        await currentWorkflowRunId(),
        currentActivityType(),
        'securityReview',
        currentAttempt()
      );
    }
  });
}
