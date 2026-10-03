import type { Prisma } from '@auto-swe/shared';

/**
 * How a terminal write found the run: `ended` — this write ended it;
 * `cancelled` — this write ended a run the dashboard had already cancelled,
 * keeping its `CANCELLED` status (the cancel route counted it); `alreadyEnded`
 * — an earlier write ended it and nothing was written.
 */
export type EndRunOutcome = 'ended' | 'cancelled' | 'alreadyEnded';

/**
 * Write a run's terminal row exactly once.
 *
 * A dashboard cancel that reached Temporal sets only `status: 'CANCELLED'` and
 * leaves `endedAt` null, so the run stays in flight — for the org cap among
 * others — until its workflow finalizes it here. The first write therefore
 * skips a cancelled row and the second ends one, keeping its status: the
 * cancel is what the user asked for, even when the workflow then reports
 * another outcome. The cancel route moves a row only from `RUNNING` to
 * `CANCELLED`, and only once, so a cancel landing between the two writes makes
 * the first miss and the second hit; no third write is needed.
 */
export async function endWorkflowRun(
  db: Prisma.TransactionClient,
  runId: string,
  data: Prisma.WorkflowRunUpdateManyMutationInput
): Promise<EndRunOutcome> {
  const ended = await db.workflowRun.updateMany({
    data,
    where: { endedAt: null, id: runId, status: { not: 'CANCELLED' } },
  });
  if (ended.count > 0) {
    return 'ended';
  }
  const cancelled = await db.workflowRun.updateMany({
    data: { ...data, status: 'CANCELLED' },
    where: { endedAt: null, id: runId, status: 'CANCELLED' },
  });
  return cancelled.count > 0 ? 'cancelled' : 'alreadyEnded';
}
