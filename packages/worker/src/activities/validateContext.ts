import { prisma } from '@auto-swe/shared/db';
import type { RepoWorkRequest, RunRequest } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { z } from 'zod';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { throwIfActivityCancelled } from '../lib/cancellation.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { getErrorMessage } from '../lib/errors.js';
import { withHeartbeat } from '../lib/execUtils.js';
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
export function buildValidationUserMessage(request: RunRequest): string {
  // Generic workflows supply a structured payload; SWE workflows keep the
  // legacy scalar fields. Prefer the payload when present.
  if (request.payload != null) {
    return JSON.stringify({ payload: request.payload });
  }
  const legacy = request as RepoWorkRequest;
  return JSON.stringify({
    description: legacy.description,
    requestPayload: legacy.requestPayload,
    title: legacy.externalTicketId,
  });
}

export async function validateContext(
  workRequest: RunRequest,
  systemPromptOverride?: string
): Promise<{ contextSnapshotId: string; successCriteria: string[] }> {
  // Heartbeats while the whole activity runs: its LLM call can outlast the
  // heartbeat timeout, and a heartbeat is how a cancellation reaches it.
  return withHeartbeat('validateContext', validateContextImpl(workRequest, systemPromptOverride));
}

async function validateContextImpl(
  workRequest: RunRequest,
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

  const userMessage = buildValidationUserMessage(workRequest);

  let successCriteria: string[] = [];
  try {
    const result = await runAgent<z.infer<typeof ContextValidationSchema>>(spec, userMessage, {
      spanName: 'llm.context_validation',
    });
    successCriteria = result.object?.successCriteria ?? [];
  } catch (err) {
    // A cancelled activity must stop, not persist a snapshot for a run the
    // workflow has already abandoned.
    throwIfActivityCancelled();
    // Graceful degradation: empty criteria still allows the workflow to
    // proceed — but say so. Downstream, the domain-logic reviewer checks the
    // diff against these criteria, and an empty list silently turns that check
    // off; an operator reading the run must be able to see why.
    const error = getErrorMessage(err);
    console.warn(
      `[validateContext] success-criteria extraction failed; continuing with none: ${error}`
    );
    const tracer = new AgentTracer();
    tracer.addActivityEvent({
      error,
      name: 'context_validation.degraded',
      outputJson: { successCriteria: 0 },
    });
    // Best-effort: the trace write must not turn a degraded run into a failed one.
    await persistActivityTrace(tracer, 'validateContext').catch(() => undefined);
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
