import { prisma } from '@auto-swe/shared/db';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { Agent } from '@mastra/core/agent';
import { trace } from '@opentelemetry/api';
import { heartbeat } from '@temporalio/activity';
import { z } from 'zod';
import { CONTEXT_VALIDATOR_PROMPT } from '../agents/prompts.js';
import {
  currentActivityType,
  currentAttempt,
  currentWorkflowId,
  currentWorkflowRunId,
} from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { getModel, getModelSpec, resolveSystemPrompt } from '../lib/models.js';

const otelTracer = trace.getTracer('auto-swe-worker');

// ── Zod schema for structured output ──

const ContextValidationSchema = z.object({
  successCriteria: z.array(z.string()),
});

// ── Context Validator Activity ──

export async function validateContext(
  workRequest: RepoWorkRequest,
  systemPromptOverride?: string
): Promise<{ contextSnapshotId: string; successCriteria: string[] }> {
  heartbeat('extracting success criteria');

  const agentTracer = new AgentTracer();
  let successCriteria: string[] = [];

  try {
    successCriteria = await otelTracer.startActiveSpan('llm.context_validation', async (span) => {
      const start = Date.now();
      try {
        const modelSpec = await getModelSpec('validateContext');
        const model = await getModel('validateContext');
        span.setAttribute('llm.model', modelSpec);
        const systemPrompt = await resolveSystemPrompt(
          'validateContext',
          CONTEXT_VALIDATOR_PROMPT,
          systemPromptOverride
        );
        const agent = new Agent({
          id: 'context-validator',
          instructions: systemPrompt,
          model,
          name: 'context-validator',
        });

        const result = await agent.generate(
          [
            {
              content: JSON.stringify({
                description: workRequest.description,
                requestPayload: workRequest.requestPayload,
                title: workRequest.externalTicketId,
              }),
              role: 'user',
            },
          ],
          { structuredOutput: { schema: ContextValidationSchema } }
        );

        if (result.usage) {
          await recordLlmUsage(
            currentWorkflowId(),
            'validateContext',
            result.usage,
            'llm.context_validation'
          );
        }

        if (!result.object) {
          agentTracer.addLlmResponse({
            durationMs: Date.now() - start,
            error: 'no structured output',
            role: 'validateContext',
          });
          return [];
        }
        const parsed = result.object as z.infer<typeof ContextValidationSchema>;

        agentTracer.addLlmResponse({
          durationMs: Date.now() - start,
          outputJson: {
            criteriaCount: parsed.successCriteria.length,
            successCriteria: parsed.successCriteria,
          },
          role: 'validateContext',
        });

        return parsed.successCriteria;
      } catch (e) {
        agentTracer.addLlmResponse({
          durationMs: Date.now() - start,
          error: (e as Error).message,
          role: 'validateContext',
        });
        span.recordException(e as Error);
        throw e;
      } finally {
        span.end();
      }
    });
  } catch {
    // Graceful degradation: empty criteria still allows workflow to proceed
  }

  await agentTracer.persist(
    await currentWorkflowRunId(),
    currentActivityType(),
    'validateContext',
    currentAttempt()
  );

  heartbeat('persisting context snapshot');

  // Upsert to handle Temporal retries idempotently
  const snapshot = await prisma.contextSnapshot.upsert({
    create: {
      successCriteria,
      workRequestId: workRequest.workRequestId,
    },
    update: {
      successCriteria,
    },
    where: { workRequestId: workRequest.workRequestId },
  });

  return {
    contextSnapshotId: snapshot.id,
    successCriteria,
  };
}
