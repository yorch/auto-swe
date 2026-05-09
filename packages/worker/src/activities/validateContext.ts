import { prisma } from '@auto-swe/shared/db';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { Agent } from '@mastra/core/agent';
import { trace } from '@opentelemetry/api';
import { heartbeat } from '@temporalio/activity';
import { z } from 'zod';
import { CONTEXT_VALIDATOR_PROMPT } from '../agents/prompts.js';
import { getModel, getModelSpec } from '../lib/models.js';

const tracer = trace.getTracer('auto-swe-worker');

// ── Zod schema for structured output ──

const ContextValidationSchema = z.object({
  successCriteria: z.array(z.string()),
});

// ── Context Validator Activity ──

export async function validateContext(
  workRequest: RepoWorkRequest
): Promise<{ contextSnapshotId: string; successCriteria: string[] }> {
  heartbeat('extracting success criteria');

  let successCriteria: string[] = [];

  try {
    successCriteria = await tracer.startActiveSpan(
      'llm.context_validation',
      { attributes: { 'llm.model': getModelSpec('validateContext') } },
      async (span) => {
        try {
          const agent = new Agent({
            id: 'context-validator',
            name: 'context-validator',
            model: getModel('validateContext'),
            instructions: CONTEXT_VALIDATOR_PROMPT,
          });

          const result = await agent.generate(
            [
              {
                role: 'user',
                content: JSON.stringify({
                  title: workRequest.externalTicketId,
                  description: workRequest.description,
                  requestPayload: workRequest.requestPayload,
                }),
              },
            ],
            { structuredOutput: { schema: ContextValidationSchema } }
          );

          if (!result.object) return [];
          const parsed = result.object as z.infer<typeof ContextValidationSchema>;
          return parsed.successCriteria;
        } catch (e) {
          span.recordException(e as Error);
          throw e;
        } finally {
          span.end();
        }
      }
    );
  } catch {
    // Graceful degradation: empty criteria still allows workflow to proceed
  }

  heartbeat('persisting context snapshot');

  // Upsert to handle Temporal retries idempotently
  const snapshot = await prisma.contextSnapshot.upsert({
    where: { workRequestId: workRequest.workRequestId },
    create: {
      workRequestId: workRequest.workRequestId,
      successCriteria,
    },
    update: {
      successCriteria,
    },
  });

  return {
    contextSnapshotId: snapshot.id,
    successCriteria,
  };
}
