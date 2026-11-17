import { prisma } from '@auto-swe/shared/db';
import {
  CHILD_RESULT_MAX_CHARS,
  type ChildResult,
  ChildResultSchema,
  orchestrationWorkflowId,
} from '@auto-swe/shared/lib/orchestration';
import { logWarn } from './activityLog.js';
import { redactString } from './agentTracer.js';
import { getTemporalClient } from './temporalClient.js';

/**
 * A child agent run reaching a terminal state: build its one structured `ChildResult` from the
 * run, store it on the `OrchestrationChild`, leave a `CHILD_RESULT` message for the page, and tell
 * the orchestrator workflow with a `childFinished` signal.
 *
 * The signal is best-effort — a failure must never fail the run — and the workflow's polling
 * backstop (`refreshOrchestrationChildren`) reports any finished child whose result no turn has
 * read yet, so a lost signal strands nothing.
 */

const MAX_FILES = 500;

type RunStatus = 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED' | 'CANCELLED' | string;

function childStatus(status: RunStatus): ChildResult['status'] {
  if (status === 'SUCCESS' || status === 'SKIPPED') {
    return 'COMPLETED';
  }
  return status === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined;
}

/** Only an https URL is stored: the page links it and the orchestrator reads it. */
function httpsUrl(value: unknown): string | undefined {
  const raw = str(value, 1000);
  if (!raw) {
    return undefined;
  }
  try {
    return new URL(raw).protocol === 'https:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

function nonNegInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

const GATE_FAILURE_RE = /gate|PATH_OUT_OF_SCOPE|security/i;

/**
 * The result of a finished agent run. `snapshot` is the run's context snapshot (its `result` is
 * the terminate node's output); `failure` is the error of its failed step. Redacted and truncated.
 */
export function buildChildResult(input: {
  status: RunStatus;
  snapshot: unknown;
  costUsd: number;
  failure?: string | null;
}): ChildResult {
  const status = childStatus(input.status);
  const result = asRecord(asRecord(input.snapshot)?.result) ?? {};
  const snapshotError = str(asRecord(input.snapshot)?.error, 2000);
  const failure = input.failure ?? snapshotError;

  const text = str(result.text, CHILD_RESULT_MAX_CHARS);
  const summarySource =
    text ??
    (status === 'COMPLETED'
      ? ''
      : status === 'CANCELLED'
        ? 'The run was cancelled.'
        : `The run failed${failure ? `: ${failure}` : '.'}`);

  const files = Array.isArray(result.filesChanged) ? result.filesChanged.slice(0, MAX_FILES) : [];
  const filesChanged = files.flatMap((f) => {
    const rec = asRecord(f);
    const path = str(rec?.path, 1000);
    return path
      ? [{ added: nonNegInt(rec?.linesAdded), path, removed: nonNegInt(rec?.linesRemoved) }]
      : [];
  });

  const gateValue = result.gate;
  const gate =
    gateValue === 'passed' || gateValue === 'no_changes' || gateValue === 'not_applicable'
      ? gateValue
      : status === 'FAILED' && failure && GATE_FAILURE_RE.test(failure)
        ? ('failed' as const)
        : undefined;

  const stopped = result.stoppedReason;
  return ChildResultSchema.parse({
    branch: str(result.branch, 300),
    costUsd: Number.isFinite(input.costUsd) && input.costUsd > 0 ? input.costUsd : 0,
    filesChanged,
    gate,
    prUrl: httpsUrl(result.prUrl),
    status,
    stoppedReason: stopped === 'max_steps' || stopped === 'wall_clock' ? stopped : undefined,
    summary: redactString(summarySource).slice(0, CHILD_RESULT_MAX_CHARS),
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The orchestration a run belongs to as a child, read from the launch payload and CONFIRMED
 * against the `OrchestrationChild` row the gateway wrote in the launch transaction. The payload
 * alone is never trusted: the Agent Run template is reachable from other launch paths, and a
 * forged `orchestrationId` must not tie a run (and its finalization signal) to someone else's
 * orchestration. Null when the run is not a child.
 */
export async function childOrchestrationIdOf(
  payload: unknown,
  workRequestId: string | null | undefined
): Promise<string | null> {
  const claimed = asRecord(payload)?.orchestrationId;
  if (typeof claimed !== 'string' || !UUID_RE.test(claimed) || !workRequestId) {
    return null;
  }
  const child = await prisma.orchestrationChild.findFirst({
    select: { id: true },
    where: { orchestrationId: claimed, workRequestId },
  });
  return child ? claimed : null;
}

/**
 * The single writer of a child's STARTING to RUNNING move and of its `runId`. Called as soon as the
 * run row exists (`createWorkflowRun`) and by the polling backstop for a child that missed it.
 * Idempotent, and never touches a child that already ended.
 */
export async function markChildRunStarted(input: {
  orchestrationId: string;
  workRequestId: string;
  runId: string;
}): Promise<boolean> {
  const moved = await prisma.orchestrationChild.updateMany({
    data: { runId: input.runId, status: 'RUNNING' },
    where: {
      orchestrationId: input.orchestrationId,
      status: { in: ['STARTING', 'RUNNING'] },
      workRequestId: input.workRequestId,
    },
  });
  return moved.count > 0;
}

export interface CompletedChild {
  orchestrationId: string;
  childId: string;
}

/**
 * Record the result of the finished run `runId` on its orchestration child. Returns the child when
 * THIS call moved it to a terminal state, null when the run is not an orchestration child, is not
 * finished, or an earlier call already recorded it.
 */
export async function completeOrchestrationChild(runId: string): Promise<CompletedChild | null> {
  const run = await prisma.workflowRun.findUnique({
    select: {
      contextSnapshot: true,
      costUsdAccrued: true,
      endedAt: true,
      id: true,
      orchestrationId: true,
      status: true,
      steps: {
        orderBy: { endedAt: 'desc' },
        select: { error: true },
        take: 1,
        where: { error: { not: null } },
      },
      workRequestId: true,
    },
    where: { id: runId },
  });
  if (!run?.orchestrationId || !run.workRequestId || !run.endedAt) {
    return null;
  }
  const child = await prisma.orchestrationChild.findFirst({
    select: { id: true, status: true },
    where: { orchestrationId: run.orchestrationId, workRequestId: run.workRequestId },
  });
  if (!child || !['STARTING', 'RUNNING'].includes(child.status)) {
    return null;
  }
  const result = buildChildResult({
    costUsd: run.costUsdAccrued,
    failure: run.steps[0]?.error ? redactString(run.steps[0].error) : null,
    snapshot: run.contextSnapshot,
    status: run.status,
  });
  return await recordChildResult({
    childId: child.id,
    orchestrationId: run.orchestrationId,
    result,
    runId: run.id,
  });
}

/** Store `result` on the child and leave its `CHILD_RESULT` message, once. */
export async function recordChildResult(input: {
  childId: string;
  orchestrationId: string;
  result: ChildResult;
  runId?: string;
}): Promise<CompletedChild | null> {
  const moved = await prisma.orchestrationChild.updateMany({
    data: {
      costUsd: input.result.costUsd,
      endedAt: new Date(),
      resultJson: input.result as object,
      status: input.result.status,
      ...(input.runId ? { runId: input.runId } : {}),
    },
    where: { id: input.childId, status: { in: ['STARTING', 'RUNNING'] } },
  });
  if (moved.count === 0) {
    return null;
  }
  await prisma.orchestrationMessage
    .create({
      data: {
        body: `A child finished (${input.result.status.toLowerCase()}).`,
        childId: input.childId,
        kind: 'CHILD_RESULT',
        orchestrationId: input.orchestrationId,
        // `seen` flips once an orchestrator turn has read the result; the backstop reports the rest.
        payload: { childId: input.childId, seen: false, status: input.result.status },
        role: 'SYSTEM',
      },
    })
    .catch((err) => {
      logWarn('orchestration child result message not written', {
        childId: input.childId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  return { childId: input.childId, orchestrationId: input.orchestrationId };
}

/** Signal the orchestrator that a child finished. Never throws. */
export async function signalChildFinished(done: CompletedChild): Promise<boolean> {
  try {
    const handle = getTemporalClient().workflow.getHandle(
      orchestrationWorkflowId(done.orchestrationId)
    );
    await handle.signal('childFinished', { childId: done.childId });
    return true;
  } catch (err) {
    logWarn('orchestration childFinished signal failed; the backstop will report it', {
      childId: done.childId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Called when a run has just been finalized. A no-op for a run that is not an orchestration child.
 * Never throws: the run is already over, and nothing here may fail it.
 */
export async function onOrchestrationRunFinalized(runId: string): Promise<void> {
  try {
    const done = await completeOrchestrationChild(runId);
    if (done) {
      await signalChildFinished(done);
    }
  } catch (err) {
    logWarn('orchestration child completion failed; the backstop will reconcile it', {
      error: err instanceof Error ? err.message : String(err),
      runId,
    });
  }
}

/** Which of `childIds` still have a result no orchestrator turn has read. */
export async function unreadChildIds(
  orchestrationId: string,
  childIds: readonly string[]
): Promise<Set<string>> {
  if (childIds.length === 0) {
    return new Set();
  }
  const rows = await prisma.orchestrationMessage.findMany({
    select: { childId: true },
    where: {
      childId: { in: [...childIds] },
      kind: 'CHILD_RESULT',
      orchestrationId,
      payload: { equals: false, path: ['seen'] },
    },
  });
  return new Set(rows.flatMap((r) => (r.childId ? [r.childId] : [])));
}

/** Mark the children's results read, once a turn that carried them has completed. */
export async function markChildResultsSeen(
  orchestrationId: string,
  childIds: readonly string[]
): Promise<void> {
  if (childIds.length === 0) {
    return;
  }
  const rows = await prisma.orchestrationMessage.findMany({
    select: { childId: true, id: true, payload: true },
    where: {
      childId: { in: [...childIds] },
      kind: 'CHILD_RESULT',
      orchestrationId,
      payload: { equals: false, path: ['seen'] },
    },
  });
  for (const row of rows) {
    const payload = asRecord(row.payload) ?? {};
    await prisma.orchestrationMessage.update({
      data: { payload: { ...payload, seen: true } },
      where: { id: row.id },
    });
  }
}
