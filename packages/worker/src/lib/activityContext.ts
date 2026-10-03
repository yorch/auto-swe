import { prisma } from '@auto-swe/shared/db';
import { trace } from '@opentelemetry/api';
import { activityInfo, Context } from '@temporalio/activity';
import { currentNodeTag } from './activityNodeTag.js';
import type { AgentTracer } from './agentTracer.js';
import { takePersistingUsage } from './runlessBudget.js';
import { currentSpendOwner } from './spendOwner.js';

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
 * Temporal's run id for the execution the current activity belongs to, or null
 * outside an activity. Unlike the workflow id, it is unique per execution: a
 * workflow id can be started again once its earlier execution has closed.
 */
export function currentTemporalRunId(): string | null {
  try {
    return activityInfo().workflowExecution?.runId ?? null;
  } catch {
    return null;
  }
}

/** The current workflow's `WorkflowRun.id`, undefined when it has none. Throws when the read fails. */
async function findWorkflowRunId(): Promise<string | undefined> {
  const run = await prisma.workflowRun.findUnique({
    select: { id: true },
    where: { workflowId: currentWorkflowId() },
  });
  return run?.id;
}

/**
 * Look up the `WorkflowRun.id` row for the currently executing Temporal
 * workflow so artifacts produced by an activity link back to the run. Returns
 * undefined when no row exists yet (race against `createWorkflowRun`) or when
 * the lookup fails — artifact persistence is best-effort.
 */
export async function currentWorkflowRunId(): Promise<string | undefined> {
  try {
    return await findWorkflowRunId();
  } catch {
    return undefined;
  }
}

/** Next free `seq` per activity attempt, keyed by the attempt's own Context. */
const nextSeq = new WeakMap<Context, number>();

/**
 * Reserve `count` consecutive `seq` values in the current attempt. An activity
 * can persist more than one tracer (its own, plus `runAgent`'s), and each
 * tracer numbers its records from 0; without an offset their rows collide and
 * the run viewer's order between them is arbitrary.
 */
function reserveSeq(count: number): number {
  const ctx = Context.current();
  const base = nextSeq.get(ctx) ?? 0;
  nextSeq.set(ctx, base + count);
  return base;
}

/**
 * Persist all in-memory traces for the currently executing activity.
 * Captures the active OTel span context (if any, and unless the caller already
 * attached a more specific one) so trace rows can be correlated with
 * Grafana/Tempo spans via otelTraceId/otelSpanId.
 * Best-effort: errors are swallowed inside `AgentTracer.persist`.
 */
export async function persistActivityTrace(tracer: AgentTracer, agentKey: string): Promise<void> {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!tracer.hasSpanContext() && spanContext?.traceId && spanContext?.spanId) {
    tracer.setSpanContext(spanContext.traceId, spanContext.spanId);
  }
  const [run, owner] = await Promise.all([
    findWorkflowRunId().then(
      (id) => ({ id }),
      () => null
    ),
    currentSpendOwner(),
  ]);
  const workflowId = currentWorkflowId();
  const temporalRunId = currentTemporalRunId();
  // A failed run lookup cannot tell a runless workflow from one with a run, so
  // its rows carry no owner. `orgMonthSpend` counts an owner-stamped row with no
  // run as runless spend, and a run's spend is already counted from its ledger:
  // stamping the owner here would bill that run to its org twice.
  const tags = run ? { ...owner, runId: run.id } : { runId: undefined };
  // The rows about to be written carry this activity's runless spend: take it
  // out of the in-process sum first, and put it back if the write fails.
  const { input, output } = tracer.llmTokenTotals();
  const restore = takePersistingUsage(workflowId, temporalRunId, input, output);
  const written = await tracer.persist(
    { ...tags, temporalRunId, workflowId },
    currentActivityType(),
    agentKey,
    currentAttempt(),
    currentNodeTag(),
    reserveSeq(tracer.size)
  );
  if (!written) {
    restore();
  }
}
