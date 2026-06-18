import { prisma } from '@auto-swe/shared/db';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { z } from 'zod';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { runAgent } from './runAgent.js';

// ── Zod schema for structured output ──

const ContextValidationSchema = z.object({
  successCriteria: z.array(z.string()),
});

// ── Context Validator Activity ──

/**
 * Proof-migration for the WS3 `AgentSpec`/`runAgent` foundation: this activity
 * is the first caller of the normalized resolution + generic agent loop. It
 * resolves a tool-free spec for the `validateContext` role and delegates the
 * model call (tracing + cost) to `runAgent`, keeping only the snapshot upsert
 * and the graceful-degradation behavior (an LLM failure yields empty criteria
 * so the workflow can still proceed).
 */
export async function validateContext(
  workRequest: RepoWorkRequest,
  systemPromptOverride?: string
): Promise<{ contextSnapshotId: string; successCriteria: string[] }> {
  heartbeat('extracting success criteria');

  const ctx = await currentRequestContext();
  const spec = await resolveAgentSpec(
    {
      agentKey: 'validateContext',
      outputSchema: ContextValidationSchema,
      promptOverride: systemPromptOverride,
    },
    ctx
  );

  const userMessage = JSON.stringify({
    description: workRequest.description,
    requestPayload: workRequest.requestPayload,
    title: workRequest.externalTicketId,
  });

  let successCriteria: string[] = [];
  try {
    const result = await runAgent<z.infer<typeof ContextValidationSchema>>(spec, userMessage, {
      spanName: 'llm.context_validation',
    });
    successCriteria = result.object?.successCriteria ?? [];
  } catch {
    // Graceful degradation: empty criteria still allows the workflow to proceed.
  }

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
