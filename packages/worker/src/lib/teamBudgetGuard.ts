import { configCacheTtlMs, withCache } from '@auto-swe/shared/config/cache';
import { prisma } from '@auto-swe/shared/db';
import { teamMonthSpend, usdToCents } from '@auto-swe/shared/lib/billing';
import { ApplicationFailure } from '@temporalio/activity';
import { logWarn } from './activityLog.js';
import { currentSpendOwner } from './spendOwner.js';

/**
 * The team whose own monthly cap this workflow's spend counts against: the team the run is
 * attributed to (`WorkflowRun.attributedTeamId` — the OWNER of its repository, else the channel's,
 * service principal's or template's team, else the team its connection-less launch was held to,
 * `RunInput.billingTeamId`). That is the team `teamMonthSpend` counts the run under, so the guard
 * and the figure it reads name one team: a run that exists with no attributed team is counted in
 * no team's spend, and is capped by none.
 *
 * Only before the run row exists is the team derived from the rows that will attribute it: the
 * owner of the ledger row's repository, else the team the ledger's request was charged to.
 *
 * `stable` is true once the run exists or a team is known, and the caller may then cache the
 * answer. A workflow with neither (epic planning, authoring, scheduled evals) is counted through
 * the spend owner its activity declared, which the caller reads from the ambient context and
 * never caches.
 */
export async function resolveBilledTeam(
  workflowId: string
): Promise<{ teamId: string | null; stable: boolean }> {
  const [run, ledger] = await Promise.all([
    prisma.workflowRun.findUnique({
      select: { attributedTeamId: true },
      where: { workflowId },
    }),
    prisma.activeWorkflow.findFirst({
      select: {
        repository: { select: { teamId: true } },
        workRequest: { select: { billingTeamId: true } },
      },
      where: { temporalWorkflowId: workflowId },
    }),
  ]);
  if (run) {
    return { stable: true, teamId: run.attributedTeamId ?? null };
  }
  const teamId = ledger?.repository?.teamId ?? ledger?.workRequest?.billingTeamId ?? null;
  return { stable: teamId != null, teamId };
}

interface TeamCapState {
  capCents: number | null;
  spentUsd: number;
}

/**
 * Refuses the next model call once the run's owning team has spent its own monthly USD cap, with
 * the same non-retryable `BUDGET_EXCEEDED` the organization's cap throws, so every caller that
 * treats that as "stop, don't retry" treats this the same. It is the mid-run half of the launch
 * gate's `decideTeamBudgets`: a run that crosses the cap stops, like a run that crosses the
 * organization's. The message and details carry no amount: they reach the run viewer.
 *
 * Spend is `teamMonthSpend`, read through a per-team cache of one config-cache window, with the
 * cap read inside the same entry. Fails open on a read error, as the organization guard does. A
 * team with no cap costs one cached read per window.
 */
export async function assertTeamBudgetAvailable(workflowId: string, label: string): Promise<void> {
  let teamId: string | null;
  let state: TeamCapState;
  try {
    const ttl = configCacheTtlMs();
    const resolved = await withCache(
      `team-budget-owner:${workflowId}`,
      ttl,
      () => resolveBilledTeam(workflowId),
      (r) => r.stable
    );
    teamId = resolved.stable ? resolved.teamId : ((await currentSpendOwner()).teamId ?? null);
    if (!teamId) {
      return;
    }
    const id = teamId;
    state = await withCache(`team-budget:${id}`, ttl, async () => {
      const team = await prisma.team.findUnique({
        select: { monthlyBudgetUsdCents: true },
        where: { id },
      });
      const capCents = team?.monthlyBudgetUsdCents ?? null;
      if (capCents == null) {
        return { capCents, spentUsd: 0 };
      }
      return { capCents, spentUsd: (await teamMonthSpend(prisma, id)).totalUsd };
    });
  } catch (err) {
    logWarn('Team budget unreadable — the call is not capped by it', {
      error: err instanceof Error ? err.message : String(err),
      workflowId,
    });
    return;
  }
  if (state.capCents == null || usdToCents(state.spentUsd) < state.capCents) {
    return;
  }
  throw ApplicationFailure.nonRetryable(
    `The team's monthly budget is already exhausted before ${label}`,
    'BUDGET_EXCEEDED',
    { cap: 'team', label, teamId }
  );
}
