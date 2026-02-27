import { heartbeat } from '@temporalio/activity';
import { Agent } from '@mastra/core';
import { anthropic } from '@ai-sdk/anthropic';
import { trace } from '@opentelemetry/api';
import { z } from 'zod';
import { prisma } from '@auto-swe/shared/db';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { CONTEXT_VALIDATOR_PROMPT } from '../agents/prompts.js';

const tracer = trace.getTracer('auto-swe-worker');

// ── Zod schema for structured output ──

const ContextValidationSchema = z.object({
  successCriteria: z.array(z.string()),
});

// ── Context Validator Activity ──

export async function validateContext(
  workRequest: RepoWorkRequest,
): Promise<{ contextSnapshotId: string; successCriteria: string[] }> {
  heartbeat('extracting success criteria');

  let successCriteria: string[] = [];

  try {
    successCriteria = await tracer.startActiveSpan(
      'llm.context_validation',
      { attributes: { 'llm.model': 'claude-sonnet-4-20250514' } },
      async (span) => {
        try {
          const agent = new Agent({
            id: 'context-validator',
            name: 'context-validator',
            model: anthropic('claude-sonnet-4-20250514'),
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
            { output: ContextValidationSchema },
          );

          const parsed = result.object as z.infer<typeof ContextValidationSchema>;
          return parsed.successCriteria;
        } catch (e) {
          span.recordException(e as Error);
          throw e;
        } finally {
          span.end();
        }
      },
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
