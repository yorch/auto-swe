/**
 * The budget a team's work runs under, as the dashboard shows it: a state and a percentage, never an
 * amount.
 *
 * Two caps can refuse a launch on a team's repositories: the organization's (`ORG_BUDGET_EXCEEDED`)
 * and the team's own (`TEAM_BUDGET_EXCEEDED`). The meter shows the one that is tighter, by the
 * share of its cap already used, and says which with `scope`. A team with no cap of its own shows
 * the organization's, exactly as before teams could set one.
 */
import type { PrismaClient } from '@auto-swe/shared';
import { teamMonthSpend } from '@auto-swe/shared/lib/billing';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { BudgetStatus } from '@auto-swe/shared/types/api';
import { budgetStatusFor, orgBudgetStatuses } from './orgBudgetStatus.js';

const SEVERITY: Record<BudgetStatus['state'], number> = {
  alert: 1,
  no_cap: -1,
  ok: 0,
  over: 3,
  projected_over: 2,
};

/**
 * The tighter of two statuses: the one with the larger share of its cap used. An equal share goes
 * to the more severe state (a cap that refuses launches beats one that merely has not yet), and a
 * remaining tie to the team, the more specific of the two. A side with no cap never binds; with
 * neither capped the answer is the organization's `no_cap` status when given, else the team's.
 * Pure.
 */
export function tighterBudgetStatus(
  org: BudgetStatus | null | undefined,
  team: BudgetStatus | null | undefined
): BudgetStatus | null {
  const capped = [team, org].filter(
    (s): s is BudgetStatus => !!s && s.state !== 'no_cap' && s.percentUsed !== null
  );
  if (capped.length === 0) {
    return org ?? team ?? null;
  }
  return capped.reduce((best, candidate) => {
    const bestPct = best.percentUsed ?? 0;
    const candidatePct = candidate.percentUsed ?? 0;
    if (candidatePct !== bestPct) {
      return candidatePct > bestPct ? candidate : best;
    }
    return SEVERITY[candidate.state] > SEVERITY[best.state] ? candidate : best;
  });
}

/**
 * The status of every named team's own cap, in one read of the teams and one spend read per team
 * that has a cap. A team with no cap is absent from the map.
 */
export async function ownTeamBudgetStatuses(
  prisma: PrismaClient,
  teamIds: readonly string[],
  now: Date = new Date()
): Promise<Map<string, BudgetStatus>> {
  const result = new Map<string, BudgetStatus>();
  const ids = [...new Set(teamIds)];
  if (ids.length === 0) {
    return result;
  }
  // By the ids the caller passes, which the routes take from a team the caller belongs to.
  const teams = await runUnscoped('the budgets of teams named by id', ['Team'], () =>
    prisma.team.findMany({
      select: { budgetAlertThresholdPercent: true, id: true, monthlyBudgetUsdCents: true },
      where: { id: { in: ids } },
    })
  );
  await Promise.all(
    teams
      .filter((team) => team.monthlyBudgetUsdCents != null)
      .map(async (team) => {
        const spend = await teamMonthSpend(prisma, team.id);
        result.set(team.id, budgetStatusFor(team, spend.totalUsd, now, 'team'));
      })
  );
  return result;
}

/**
 * The binding status of each team, keyed by team id, for teams that have one (a cap of their own or
 * of their organization). One batched read for all teams, never one per team: the organizations'
 * statuses and the teams' own, then {@link tighterBudgetStatus} per team.
 */
export async function bindingBudgetStatuses(
  prisma: PrismaClient,
  teams: ReadonlyArray<{ id: string; orgId: string }>,
  now: Date = new Date()
): Promise<Map<string, BudgetStatus>> {
  const [orgStatuses, teamStatuses] = await Promise.all([
    orgBudgetStatuses(
      prisma,
      teams.map((t) => t.orgId),
      now
    ),
    ownTeamBudgetStatuses(
      prisma,
      teams.map((t) => t.id),
      now
    ),
  ]);
  const result = new Map<string, BudgetStatus>();
  for (const team of teams) {
    const status = tighterBudgetStatus(orgStatuses.get(team.orgId), teamStatuses.get(team.id));
    if (status) {
      result.set(team.id, status);
    }
  }
  return result;
}
