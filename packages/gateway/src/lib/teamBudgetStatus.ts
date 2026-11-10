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
import { budgetStatusFor, tighterBudgetStatus } from '@auto-swe/shared/lib/budgetStatus';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { BudgetStatus } from '@auto-swe/shared/types/api';
import { orgBudgetStatuses } from './orgBudgetStatus.js';

export { tighterBudgetStatus };

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

/**
 * Where the cap a launch on each repository is held to stands, keyed by repository id: the
 * OWNING team's binding status (its own cap or its organization's, the tighter), because the
 * owner's budget pays for a launch through a share. One batched read for all repositories,
 * grouped by owning team, never one per repository. A repository whose owner has no cap is
 * absent from the map. The status is percent-only, so it carries no amount.
 */
export async function ownerLaunchBudgets(
  prisma: PrismaClient,
  repos: ReadonlyArray<{ id: string; team: { id: string; orgId: string } }>,
  now: Date = new Date()
): Promise<Map<string, BudgetStatus>> {
  const owners = new Map<string, { id: string; orgId: string }>();
  for (const repo of repos) {
    owners.set(repo.team.id, { id: repo.team.id, orgId: repo.team.orgId });
  }
  const byTeam = await bindingBudgetStatuses(prisma, [...owners.values()], now);
  const result = new Map<string, BudgetStatus>();
  for (const repo of repos) {
    const status = byTeam.get(repo.team.id);
    if (status) {
      result.set(repo.id, status);
    }
  }
  return result;
}
