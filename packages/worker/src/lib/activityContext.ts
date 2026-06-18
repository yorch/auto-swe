import { prisma } from '@auto-swe/shared/db';
import { trace } from '@opentelemetry/api';
import { activityInfo } from '@temporalio/activity';
import type { AgentTracer } from './agentTracer.js';

/**
 * Returns the Temporal activity type (function name) for the currently
 * executing activity, e.g. "executeImplementation". Used as the nodeId
 * correlator for AgentTrace records.
 */
export function currentActivityType(): string {
  return activityInfo().activityType;
}

/**
 * Returns the current Temporal activity attempt number (1-based). Stored on
 * AgentTrace rows so the UI can separate traces from different retry attempts.
 */
export function currentAttempt(): number {
  return activityInfo().attempt;
}

/**
 * Returns the Temporal workflow ID that scheduled the current activity.
 *
 * `Info.workflowExecution` is typed as optional because the Temporal SDK
 * supports activities started outside a workflow (e.g. raw `ActivityClient`
 * use). Every activity in this codebase is workflow-driven, so a missing
 * value is a programmer error — fail loudly rather than passing `undefined`
 * downstream.
 */
export function currentWorkflowId(): string {
  const execution = activityInfo().workflowExecution;
  if (!execution) {
    throw new Error(
      'currentWorkflowId() called outside of a workflow-scheduled activity (Info.workflowExecution is undefined)'
    );
  }
  return execution.workflowId;
}

/**
 * Look up the `WorkflowRun.id` row for the currently executing Temporal
 * workflow so artifacts produced by an activity link back to the run. Returns
 * undefined when no row exists yet (race against `createWorkflowRun`) or when
 * the lookup fails — artifact persistence is best-effort.
 */
export async function currentWorkflowRunId(): Promise<string | undefined> {
  try {
    const wid = currentWorkflowId();
    const run = await prisma.workflowRun.findUnique({
      select: { id: true },
      where: { workflowId: wid },
    });
    return run?.id;
  } catch {
    return undefined;
  }
}

/**
 * Persist all in-memory traces for the currently executing activity.
 * Captures the active OTel span context (if any) so trace rows can be
 * correlated with Grafana/Tempo spans via otelTraceId/otelSpanId.
 * Best-effort: errors are swallowed inside `AgentTracer.persist`.
 */
export async function persistActivityTrace(tracer: AgentTracer, agentKey: string): Promise<void> {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (spanContext?.traceId && spanContext?.spanId) {
    tracer.setSpanContext(spanContext.traceId, spanContext.spanId);
  }
  await tracer.persist(
    await currentWorkflowRunId(),
    currentActivityType(),
    agentKey,
    currentAttempt()
  );
}
