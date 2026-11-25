/**
 * What a campaign's attempts have spent this month: the ONE definition the gateway's start guard
 * and the worker's reconcile pass both read, so the two can never disagree about "exceeded".
 *
 * Two ledgers record an attempt's cost and they are written at different times:
 *
 * - `ActiveWorkflow.costUsdAccrued` accrues live, call by call, while the run executes, and is
 *   keyed by the Temporal workflow id (`CampaignAttempt.childWorkflowId`). It exists from the first
 *   call, before the attempt has a `WorkflowRun` row.
 * - `WorkflowRun.costUsdAccrued` is a denormalisation `finalizeWorkflowRun` writes once, when the
 *   run ends (`endedAt` is set); until then it is 0. For a run with no ActiveWorkflow row it is
 *   the only record (summed from traces).
 *
 * Precedence, per attempt, so each attempt is counted exactly once:
 *   1. its run is finalized (`run.endedAt` set): the run's figure, the settled one;
 *   2. else its ActiveWorkflow row, found by `childWorkflowId`: the live figure, which covers an
 *      attempt in flight and one that has cost but no run row yet;
 *   3. else the run's figure (0 for an unfinished run), else 0.
 * Summing both ledgers would double count every finished attempt; summing only the run's would
 * miss everything in flight.
 */

/** The first instant of the UTC calendar month `now` falls in: the window a budget counts. */
export function campaignMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The slice of a Prisma client this reads, so it can be unit-tested with a fake. */
export interface CampaignSpendClient {
  campaignAttempt: {
    findMany(args: {
      select: {
        childWorkflowId: true;
        run: { select: { costUsdAccrued: true; endedAt: true } };
      };
      where: {
        startedAt: { gte: Date };
        target: { campaignId: string; campaign: { orgId: string } };
      };
    }): Promise<
      Array<{
        childWorkflowId: string | null;
        run: { costUsdAccrued: unknown; endedAt: Date | null } | null;
      }>
    >;
  };
  activeWorkflow: {
    findMany(args: {
      select: { temporalWorkflowId: true; costUsdAccrued: true };
      where: { temporalWorkflowId: { in: string[] } };
    }): Promise<Array<{ temporalWorkflowId: string; costUsdAccrued: unknown }>>;
  };
}

export interface CampaignSpendInput {
  campaignId: string;
  orgId: string;
  /** From `campaignMonthStart`. */
  monthStart: Date;
}

export async function campaignSpendUsd(
  client: CampaignSpendClient,
  { campaignId, monthStart, orgId }: CampaignSpendInput
): Promise<number> {
  const attempts = await client.campaignAttempt.findMany({
    select: {
      childWorkflowId: true,
      run: { select: { costUsdAccrued: true, endedAt: true } },
    },
    where: { startedAt: { gte: monthStart }, target: { campaign: { orgId }, campaignId } },
  });
  const ids = attempts.flatMap((a) =>
    a.childWorkflowId && !a.run?.endedAt ? [a.childWorkflowId] : []
  );
  const ledger = new Map<string, number>();
  if (ids.length > 0) {
    const rows = await client.activeWorkflow.findMany({
      select: { costUsdAccrued: true, temporalWorkflowId: true },
      where: { temporalWorkflowId: { in: ids } },
    });
    for (const row of rows) {
      ledger.set(row.temporalWorkflowId, Number(row.costUsdAccrued ?? 0));
    }
  }
  let total = 0;
  for (const a of attempts) {
    if (a.run?.endedAt) {
      total += Number(a.run.costUsdAccrued ?? 0);
      continue;
    }
    const live = a.childWorkflowId ? ledger.get(a.childWorkflowId) : undefined;
    total += live ?? Number(a.run?.costUsdAccrued ?? 0);
  }
  return total;
}
