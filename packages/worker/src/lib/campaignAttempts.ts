import { prisma } from '@auto-swe/shared/db';
import {
  boundFailureReason,
  type CampaignTargetPathName,
  type CampaignVerificationName,
  campaignTargetOutcome,
} from '@auto-swe/shared/lib/campaignOutcome';
import type { CampaignAttemptOutcomeValue } from '@auto-swe/shared/lib/campaignState';
import { ACTIVE_WORKFLOW_TERMINAL_STATUSES } from '@auto-swe/shared/types/api';
import {
  CAMPAIGN_ATTEMPT_FINISHED_SIGNAL,
  type CampaignAttemptFinishedSignal,
} from '@auto-swe/shared/types/workflow';
import { logWarn } from './activityLog.js';
import { maskCredentialShapes } from './redactToken.js';
import { getTemporalClient } from './temporalClient.js';

/**
 * A campaign attempt is one child run for one campaign target. The gateway writes the attempt row
 * (with the child's workflow id) in the same transaction that starts the run; the worker's two
 * hooks keep it true afterwards:
 *
 *  - {@link markCampaignAttemptRunStarted}, when the run row is created: names the run on its
 *    attempt, so a pull request (`pull_requests.run_id`) and a finish are found through it;
 *  - {@link onCampaignRunFinalized}, when the run is finalized: records the attempt's outcome, its
 *    path and verification and tells the campaign's workflow with `campaignAttemptFinished`.
 *
 * Both are best-effort and never throw: the run is already going or over. The reconciler's read
 * (`readCampaignPass`) finishes any attempt whose run ended without the hook having run
 * ({@link reconcileCampaignAttempt}), so a lost signal or a failed write strands nothing.
 *
 * There is no pull-request column on the attempt: the pull request a target delivered is the
 * `PullRequest` row of its latest attempt's run, which webhooks keep current. The attempt records
 * only what the run's result said about the change.
 */

/** A run row, as the completion needs it. */
interface FinishedRun {
  id: string;
  status: string;
  workflowId: string | null;
  contextSnapshot: unknown;
  steps: Array<{ error: string | null }>;
}

export interface AttemptOutcomeFields {
  outcome: CampaignAttemptOutcomeValue;
  failureReason: string | null;
  path: CampaignTargetPathName | null;
  verification: CampaignVerificationName | null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The attempt's outcome from a finished run. The run's result is the terminate node's output with
 * the run's status spread over it, which is what `campaignTargetOutcome` reads (the same mapper
 * the legacy workflow used for its children). A run that ended `SUCCESS` without a `prUrl` in its
 * result still opened a pull request when a `PullRequest` row names it, so that is asked before the
 * attempt is called a failure.
 */
export async function attemptOutcomeFromRun(run: FinishedRun): Promise<AttemptOutcomeFields> {
  const result = asRecord(asRecord(run.contextSnapshot)?.result) ?? {};
  const cancelled = run.status === 'CANCELLED';
  const o = campaignTargetOutcome(
    { ...result, status: cancelled ? 'FAILED' : run.status },
    { cancelled, mask: maskCredentialShapes }
  );
  const base = { path: o.path, verification: o.verification };
  switch (o.state) {
    case 'PR_OPENED':
      return { ...base, failureReason: null, outcome: 'PR_OPENED' };
    case 'NOT_AFFECTED':
      return { ...base, failureReason: null, outcome: 'NO_CHANGE' };
    case 'CANCELLED':
      return { ...base, failureReason: null, outcome: 'CANCELLED' };
    default: {
      if (run.status === 'SUCCESS') {
        const pr = await prisma.pullRequest.findFirst({
          select: { id: true },
          where: { runId: run.id },
        });
        if (pr) {
          return { ...base, failureReason: null, outcome: 'PR_OPENED' };
        }
      }
      const stepError = run.steps[0]?.error;
      const reason =
        o.failureReason ??
        (stepError ? boundFailureReason(stepError, maskCredentialShapes) : null) ??
        'the run failed';
      return { ...base, failureReason: reason, outcome: 'FAILED' };
    }
  }
}

const RUN_SELECT = {
  contextSnapshot: true,
  endedAt: true,
  id: true,
  status: true,
  steps: {
    orderBy: { endedAt: 'desc' as const },
    select: { error: true },
    take: 1,
    where: { error: { not: null } },
  },
  workflowId: true,
};

/**
 * Name the run on the attempt that started it. `workflowId` is the child's workflow id, which the
 * gateway wrote on the attempt. Idempotent; a run that belongs to no attempt changes nothing.
 */
export async function markCampaignAttemptRunStarted(input: {
  workflowId: string;
  runId: string;
}): Promise<boolean> {
  const moved = await prisma.campaignAttempt.updateMany({
    data: { runId: input.runId },
    where: { childWorkflowId: input.workflowId, runId: null },
  });
  return moved.count > 0;
}

export interface CompletedAttempt {
  attemptId: string;
  targetId: string;
  n: number;
  runId: string;
  campaignWorkflowId: string;
  /**
   * Whether the campaign runs on the reconciler. A legacy campaign's workflow has no signal to
   * receive (it reads its children through Temporal), so it is never sent one.
   */
  reconciler: boolean;
}

/**
 * Record the outcome of the attempt whose run ended. Returns the attempt when THIS call recorded
 * it, null when there is none for the run, the run is not over, or an earlier call already
 * recorded it. The write is conditional on `outcome IS NULL`, so a duplicate delivery is a no-op.
 */
export async function completeCampaignAttemptForRun(
  runId: string
): Promise<CompletedAttempt | null> {
  const run = await prisma.workflowRun.findUnique({
    select: RUN_SELECT,
    where: { id: runId },
  });
  if (!run?.endedAt) {
    return null;
  }
  const attempt = await prisma.campaignAttempt.findFirst({
    select: {
      id: true,
      n: true,
      target: {
        select: {
          campaign: { select: { temporalWorkflowId: true, workflowKind: true } },
          id: true,
        },
      },
    },
    where: {
      OR: [{ runId }, ...(run.workflowId ? [{ childWorkflowId: run.workflowId }] : [])],
      outcome: null,
    },
  });
  if (!attempt) {
    return null;
  }
  return recordAttemptOutcome(
    {
      campaignWorkflowId: attempt.target.campaign.temporalWorkflowId,
      id: attempt.id,
      n: attempt.n,
      reconciler: attempt.target.campaign.workflowKind === 'RECONCILER',
      targetId: attempt.target.id,
    },
    run
  );
}

async function recordAttemptOutcome(
  attempt: {
    id: string;
    n: number;
    targetId: string;
    campaignWorkflowId: string;
    reconciler: boolean;
  },
  run: FinishedRun
): Promise<CompletedAttempt | null> {
  const fields = await attemptOutcomeFromRun(run);
  const moved = await prisma.campaignAttempt.updateMany({
    data: {
      failureReason: fields.failureReason,
      finishedAt: new Date(),
      outcome: fields.outcome,
      path: fields.path,
      runId: run.id,
      verification: fields.verification,
    },
    where: { id: attempt.id, outcome: null },
  });
  if (moved.count === 0) {
    return null;
  }
  return {
    attemptId: attempt.id,
    campaignWorkflowId: attempt.campaignWorkflowId,
    n: attempt.n,
    reconciler: attempt.reconciler,
    runId: run.id,
    targetId: attempt.targetId,
  };
}

/** Tell the campaign's workflow that an attempt finished. Never throws. */
export async function signalCampaignAttemptFinished(done: CompletedAttempt): Promise<boolean> {
  try {
    const handle = getTemporalClient().workflow.getHandle(done.campaignWorkflowId);
    const payload: CampaignAttemptFinishedSignal = {
      attemptN: done.n,
      runId: done.runId,
      targetId: done.targetId,
    };
    await handle.signal(CAMPAIGN_ATTEMPT_FINISHED_SIGNAL, payload);
    return true;
  } catch (err) {
    logWarn('campaign attemptFinished signal failed; the reconciler will read it from the rows', {
      attemptId: done.attemptId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Called when a run has just been finalized. A no-op for a run that belongs to no campaign
 * attempt. Never throws: the run is already over, and nothing here may fail it.
 */
export async function onCampaignRunFinalized(runId: string): Promise<void> {
  try {
    const done = await completeCampaignAttemptForRun(runId);
    if (done?.reconciler) {
      await signalCampaignAttemptFinished(done);
    }
  } catch (err) {
    logWarn('campaign attempt completion failed; the reconciler will reconcile it', {
      error: err instanceof Error ? err.message : String(err),
      runId,
    });
  }
}

/** An attempt whose run row never appeared is failed after this long, once its ledger is dead. */
export const ATTEMPT_NEVER_STARTED_MS = 10 * 60 * 1000;
/**
 * An attempt whose run row never appeared is failed after this long when Temporal says its child
 * workflow is gone or closed, whatever the ledger says (a child that died before it wrote a ledger
 * row, or before anything updated one, would otherwise hold a `maxParallel` slot forever).
 */
export const ATTEMPT_RUN_GRACE_MS = 30 * 60 * 1000;

/**
 * Whether Temporal still has the child workflow running. `null` when that cannot be told (the
 * server could not be asked): nothing is decided on a guess.
 */
async function childWorkflowRunning(workflowId: string): Promise<boolean | null> {
  try {
    const description = await getTemporalClient().workflow.getHandle(workflowId).describe();
    return description.status.name === 'RUNNING';
  } catch (err) {
    const name = (err as { name?: string } | null)?.name ?? '';
    return /NotFound/i.test(name) ? false : null;
  }
}

/**
 * Moves the ledger row of an attempt whose run never started to `FAILED`, so it stops counting
 * against its launcher's run cap. Only a row still non-terminal is written, and a failure here
 * is logged and swallowed: the attempt is already closed.
 */
async function closeNeverStartedLedgerRow(childWorkflowId: string): Promise<void> {
  try {
    await prisma.activeWorkflow.updateMany({
      data: { currentStatus: 'FAILED' },
      where: {
        currentStatus: { notIn: [...ACTIVE_WORKFLOW_TERMINAL_STATUSES] },
        temporalWorkflowId: childWorkflowId,
      },
    });
  } catch {
    logWarn('campaign attempt ledger close failed', { childWorkflowId });
  }
}

export interface UnfinishedAttempt {
  id: string;
  n: number;
  targetId: string;
  runId: string | null;
  childWorkflowId: string | null;
  startedAt: Date;
  campaignWorkflowId: string;
  reconciler: boolean;
}

/**
 * Settle one attempt that has no outcome yet, from what the database says now: name its run when
 * the run exists, record its outcome when the run ended, and fail it when its run never appeared
 * and its workflow is dead: the ledger row says so (after {@link ATTEMPT_NEVER_STARTED_MS}), or
 * Temporal says the child is gone or closed (after {@link ATTEMPT_RUN_GRACE_MS}). Returns the
 * outcome recorded, or null when the attempt is still in flight. Never throws for a row that
 * cannot be read.
 */
export async function reconcileCampaignAttempt(
  attempt: UnfinishedAttempt,
  nowMs: number
): Promise<CompletedAttempt | null> {
  try {
    const run = attempt.runId
      ? await prisma.workflowRun.findUnique({ select: RUN_SELECT, where: { id: attempt.runId } })
      : attempt.childWorkflowId
        ? await prisma.workflowRun.findUnique({
            select: RUN_SELECT,
            where: { workflowId: attempt.childWorkflowId },
          })
        : null;
    if (run) {
      if (!attempt.runId) {
        await prisma.campaignAttempt.updateMany({
          data: { runId: run.id },
          where: { id: attempt.id, runId: null },
        });
      }
      return run.endedAt ? await recordAttemptOutcome(attempt, run) : null;
    }
    if (
      !attempt.childWorkflowId ||
      nowMs - attempt.startedAt.getTime() < ATTEMPT_NEVER_STARTED_MS
    ) {
      return null;
    }
    const ledger = await prisma.activeWorkflow.findMany({
      select: { currentStatus: true },
      where: { temporalWorkflowId: attempt.childWorkflowId },
    });
    const ledgerDead =
      ledger.length > 0 &&
      ledger.every((l) =>
        ['FAILED', 'CANCELLED', 'TIMED_OUT', 'COMPLETED'].includes(l.currentStatus)
      );
    let reason = 'the run ended without starting';
    if (!ledgerDead) {
      // The ledger cannot say (no row, or one nobody updated): after the grace, ask Temporal.
      if (nowMs - attempt.startedAt.getTime() < ATTEMPT_RUN_GRACE_MS) {
        return null;
      }
      if ((await childWorkflowRunning(attempt.childWorkflowId)) !== false) {
        return null;
      }
      reason = 'the run never started';
    }
    const moved = await prisma.campaignAttempt.updateMany({
      data: {
        failureReason: reason,
        finishedAt: new Date(),
        outcome: 'FAILED',
      },
      where: { id: attempt.id, outcome: null },
    });
    if (moved.count > 0 && !ledgerDead) {
      await closeNeverStartedLedgerRow(attempt.childWorkflowId);
    }
    return moved.count > 0
      ? {
          attemptId: attempt.id,
          campaignWorkflowId: attempt.campaignWorkflowId,
          n: attempt.n,
          reconciler: attempt.reconciler,
          runId: '',
          targetId: attempt.targetId,
        }
      : null;
  } catch (err) {
    logWarn('campaign attempt reconcile failed', {
      attemptId: attempt.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
