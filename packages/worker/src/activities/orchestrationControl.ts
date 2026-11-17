import { prisma } from '@auto-swe/shared/db';
import { logWarn } from '../lib/activityLog.js';
import {
  completeOrchestrationChild,
  markChildRunStarted,
  recordChildResult,
} from '../lib/orchestrationChildren.js';
import { createOrchestrationGateway } from '../lib/orchestrationGateway.js';
import {
  countOrchestrationLoad,
  RUNNING_CHILD_STATUSES,
  writeNotice,
} from '../lib/orchestrationState.js';
import type {
  BeginOrchestrationInput,
  BeginOrchestrationResult,
  CancelOrchestrationChildrenInput,
  CancelOrchestrationChildrenResult,
  RecordOrchestrationStatusInput,
  RefreshOrchestrationChildrenInput,
  RefreshOrchestrationChildrenResult,
} from '../lib/orchestrationTypes.js';

/**
 * The small bookkeeping activities of the orchestration workflow: starting it, recording its
 * status, reconciling children whose `childFinished` signal was lost, and cancelling children.
 * Each is safe to retry.
 */

const TERMINAL = ['COMPLETED', 'CANCELLED', 'FAILED'] as const;
/** A signal gets this long to arrive before the backstop reports a finished child. */
const SIGNAL_GRACE_MS = 90_000;
/** A child whose run never appeared is failed after this long. */
const NEVER_STARTED_MS = 5 * 60_000;

/**
 * Start (or resume) an execution of the orchestration workflow. Reads what the workflow cannot:
 * when the orchestration began, how many turns it has taken, what is in flight, and which finished
 * children no turn has read yet (a restarted workflow reports them). A stale start for an
 * orchestration that is already over does nothing.
 */
export async function beginOrchestrationRun(
  input: BeginOrchestrationInput
): Promise<BeginOrchestrationResult & { unseenChildIds: string[] }> {
  const orch = await prisma.orchestration.findUnique({
    select: { createdAt: true, status: true, teamId: true },
    where: { id: input.orchestrationId },
  });
  if (!orch || (TERMINAL as readonly string[]).includes(orch.status)) {
    return {
      createdAtMs: orch?.createdAt.getTime() ?? 0,
      pendingApprovals: 0,
      proceed: false,
      runningChildren: 0,
      turns: 0,
      unseenChildIds: [],
    };
  }
  if (orch.status !== 'ACTIVE') {
    await prisma.orchestration.updateMany({
      data: { status: 'ACTIVE' },
      where: { id: input.orchestrationId, status: 'WAITING', teamId: orch.teamId },
    });
  }
  const [turns, load, unseen] = await Promise.all([
    prisma.orchestrationMessage.count({
      where: { kind: 'TEXT', orchestrationId: input.orchestrationId, role: 'ORCHESTRATOR' },
    }),
    countOrchestrationLoad(input.orchestrationId),
    unseenChildResults(input.orchestrationId, 0),
  ]);
  return {
    createdAtMs: orch.createdAt.getTime(),
    pendingApprovals: load.pendingApprovals,
    proceed: true,
    runningChildren: load.runningChildren,
    turns,
    unseenChildIds: unseen,
  };
}

/** Children whose result is recorded but that no orchestrator turn has read, older than `graceMs`. */
async function unseenChildResults(orchestrationId: string, graceMs: number): Promise<string[]> {
  const rows = await prisma.orchestrationMessage.findMany({
    select: { childId: true },
    where: {
      childId: { not: null },
      createdAt: { lt: new Date(Date.now() - graceMs) },
      kind: 'CHILD_RESULT',
      orchestrationId,
      payload: { equals: false, path: ['seen'] },
    },
  });
  return [...new Set(rows.flatMap((r) => (r.childId ? [r.childId] : [])))];
}

/**
 * Reconcile children whose finish no signal reported: a run that ended while the signal was lost
 * is completed here, and a finished child no turn has read is reported again. Returns the ids the
 * workflow should treat as `childFinished` events.
 */
export async function refreshOrchestrationChildren(
  input: RefreshOrchestrationChildrenInput
): Promise<RefreshOrchestrationChildrenResult> {
  const { orchestrationId } = input;
  const inFlight = await prisma.orchestrationChild.findMany({
    select: { createdAt: true, id: true, runId: true, status: true, workRequestId: true },
    where: { orchestrationId, status: { in: [...RUNNING_CHILD_STATUSES] } },
  });
  const finished = new Set<string>();
  for (const child of inFlight) {
    try {
      const run = await prisma.workflowRun.findFirst({
        select: { endedAt: true, id: true },
        where: { orchestrationId, workRequestId: child.workRequestId },
      });
      if (!run) {
        await failIfNeverStarted(orchestrationId, child, finished);
        continue;
      }
      if (run.endedAt) {
        const done = await completeOrchestrationChild(run.id);
        if (done) {
          finished.add(done.childId);
        }
      } else if (child.status === 'STARTING' || !child.runId) {
        await markChildRunStarted({
          orchestrationId,
          runId: run.id,
          workRequestId: child.workRequestId,
        });
      }
    } catch (err) {
      logWarn('orchestration child reconcile failed', {
        childId: child.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  for (const id of await unseenChildResults(orchestrationId, SIGNAL_GRACE_MS)) {
    finished.add(id);
  }
  const load = await countOrchestrationLoad(orchestrationId);
  return {
    finishedChildIds: [...finished],
    pendingApprovals: load.pendingApprovals,
    runningChildren: load.runningChildren,
  };
}

/** A child whose launch left no run behind: its ledger row ended without ever starting one. */
async function failIfNeverStarted(
  orchestrationId: string,
  child: { createdAt: Date; id: string; workRequestId: string },
  finished: Set<string>
): Promise<void> {
  if (Date.now() - child.createdAt.getTime() < NEVER_STARTED_MS) {
    return;
  }
  const ledger = await prisma.activeWorkflow.findMany({
    select: { currentStatus: true },
    where: { workRequestId: child.workRequestId },
  });
  const dead =
    ledger.length > 0 &&
    ledger.every((l) => ['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(l.currentStatus));
  if (!dead) {
    return;
  }
  const done = await recordChildResult({
    childId: child.id,
    orchestrationId,
    result: {
      costUsd: 0,
      filesChanged: [],
      status: 'FAILED',
      summary: 'The run ended without starting.',
    },
  });
  if (done) {
    finished.add(done.childId);
  }
}

/**
 * Record the orchestration's status. `WAITING` and `COMPLETED` never overwrite a status the
 * gateway already ended (`CANCELLED`, `FAILED`); an end writes `endedAt`. An optional notice is
 * written with it.
 */
export async function recordOrchestrationStatus(
  input: RecordOrchestrationStatusInput
): Promise<void> {
  const ending = input.status !== 'ACTIVE' && input.status !== 'WAITING';
  const row = await prisma.orchestration.findUnique({
    select: { teamId: true },
    where: { id: input.orchestrationId },
  });
  if (!row) {
    return;
  }
  await prisma.orchestration.updateMany({
    data: { ...(ending ? { endedAt: new Date() } : {}), status: input.status },
    where: { id: input.orchestrationId, status: { notIn: [...TERMINAL] }, teamId: row.teamId },
  });
  if (input.notice) {
    await writeNotice(input.orchestrationId, input.notice.code, input.notice.body);
  }
}

/**
 * Cancel every running child through the gateway (best effort, one by one). Pushed branches stay.
 * A child the gateway refuses to cancel is logged; the next backstop pass or the run's own
 * deadline ends it.
 */
export async function cancelOrchestrationChildren(
  input: CancelOrchestrationChildrenInput
): Promise<CancelOrchestrationChildrenResult> {
  const running = await prisma.orchestrationChild.findMany({
    select: { id: true },
    where: {
      orchestrationId: input.orchestrationId,
      status: { in: [...RUNNING_CHILD_STATUSES] },
    },
  });
  const gateway = createOrchestrationGateway(input.token);
  let cancelled = 0;
  for (const child of running) {
    try {
      const res = await gateway.post(
        `/api/v1/orchestrations/${input.orchestrationId}/children/${child.id}/cancel`,
        {}
      );
      if (res.status >= 200 && res.status < 300) {
        cancelled += 1;
      }
    } catch (err) {
      logWarn('orchestration child cancel failed', {
        childId: child.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { cancelled };
}
