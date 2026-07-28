import type { FastifyInstance } from 'fastify';
import { getErrorName } from '../plugins/auth.js';
import { isUniqueConstraintError } from './prismaErrors.js';

/**
 * Launch a tracked run: write its ledger rows, then start the Temporal
 * workflow, compensating if the start fails.
 *
 * ## Why the ledger comes first
 *
 * These handlers used to start Temporal and only then write `RunInput` /
 * `ActiveWorkflow`, on the reasoning that Temporal's
 * `WorkflowExecutionAlreadyStartedError` was the idempotency gate and that
 * orphaned DB rows would block future retries. Both halves worked out badly:
 *
 * - **The failure modes are not symmetric.** If the DB write failed, a workflow
 *   was already running — burning budget, pushing branches, opening PRs — with
 *   no row to attribute it to. `recordLlmUsage` and `finalizeWorkflowRun` then
 *   operated on rows that did not exist. The reverse orphan (rows, no workflow)
 *   is inert, visible in the dashboard, and operator-recoverable.
 * - **It wedged the ticket anyway.** `allocateWorkflowId` derives its `-rN`
 *   suffix from the `ActiveWorkflow` rows for a ticket. With no row written, a
 *   resubmission re-allocated the *base* ID, which Temporal then rejected as
 *   already-started — so the ticket stayed unsubmittable until the orphaned
 *   execution aged out, with nothing in the DB to explain why.
 *
 * Writing the rows first also makes dedup **atomic**: the unique index on
 * `ActiveWorkflow.temporalWorkflowId` decides the winner of two concurrent
 * submissions, where the previous read-then-start sequence had a TOCTOU gap.
 * It is durable too — a DB row outlives Temporal's execution-retention window,
 * so a deterministic ID (`jira-<ticket>`) keeps deduping after Temporal has
 * forgotten the closed execution.
 *
 * ## Compensation
 *
 * If the start fails we delete the rows we just wrote, so a transient Temporal
 * outage doesn't permanently block the ticket. Compensation is best-effort: if
 * it also fails, the rows remain as a visible non-terminal run — the inert,
 * recoverable failure mode rather than the invisible one.
 */

/** Rows to write before the workflow starts. `runInput` is omitted on re-runs. */
export interface WorkflowLedgerRows {
  /** `RunInput` row, when this launch creates one (skipped when re-running). */
  runInput?: Record<string, unknown>;
  /** `ActiveWorkflow` row. Must carry `temporalWorkflowId`. */
  activeWorkflow: Record<string, unknown> & { temporalWorkflowId: string };
}

export type LaunchWorkflowResult =
  | { ok: true; activeWorkflowId: string }
  /**
   * Another run already owns this workflow ID — either the ledger insert lost
   * the unique-index race or Temporal reported the execution already started.
   * Callers map this to their own conflict response (409 / `duplicate: true`).
   */
  | { ok: false; reason: 'DUPLICATE' };

export async function launchTrackedWorkflow(
  prisma: FastifyInstance['prisma'],
  rows: WorkflowLedgerRows,
  start: () => Promise<unknown>,
  opts?: { log?: { error: (obj: unknown, msg?: string) => void } }
): Promise<LaunchWorkflowResult> {
  const { runInput, activeWorkflow } = rows;
  const temporalWorkflowId = activeWorkflow.temporalWorkflowId;

  // 1. Ledger first, atomically. A P2002 here is the dedup gate firing.
  let activeWorkflowId: string;
  try {
    const writes = [
      ...(runInput
        ? [prisma.runInput.create({ data: runInput as never })]
        : ([] as ReturnType<typeof prisma.runInput.create>[])),
      prisma.activeWorkflow.create({ data: activeWorkflow as never }),
    ];
    const results = (await prisma.$transaction(writes)) as Array<{ id: string }>;
    activeWorkflowId = results[results.length - 1].id;
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { ok: false, reason: 'DUPLICATE' };
    }
    throw err;
  }

  // 2. Start the workflow; undo the ledger write if it never got going.
  try {
    await start();
  } catch (err) {
    await compensate(
      prisma,
      { activeWorkflowId, runInputId: runInput?.id as string | undefined },
      {
        log: opts?.log,
        temporalWorkflowId,
      }
    );
    if (getErrorName(err) === 'WorkflowExecutionAlreadyStartedError') {
      return { ok: false, reason: 'DUPLICATE' };
    }
    throw err;
  }

  return { activeWorkflowId, ok: true };
}

/**
 * Best-effort removal of the rows written for a workflow that never started.
 * Never throws: leaving the rows behind is the recoverable failure mode, and
 * the caller still needs to surface the original start error.
 */
async function compensate(
  prisma: FastifyInstance['prisma'],
  ids: { activeWorkflowId: string; runInputId?: string },
  ctx: { temporalWorkflowId: string; log?: { error: (obj: unknown, msg?: string) => void } }
): Promise<void> {
  try {
    await prisma.activeWorkflow.delete({ where: { id: ids.activeWorkflowId } });
    if (ids.runInputId) {
      await prisma.runInput.delete({ where: { id: ids.runInputId } });
    }
  } catch (cleanupErr) {
    ctx.log?.error(
      { err: cleanupErr, temporalWorkflowId: ctx.temporalWorkflowId },
      'workflow start failed and ledger cleanup also failed — rows left for manual recovery'
    );
  }
}
