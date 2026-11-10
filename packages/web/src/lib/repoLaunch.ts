import type { BudgetStatus, TeamRef } from '@auto-swe/shared/types/api';

/** Why a repository cannot be picked for new work; fixed wording, shown beside the option. */
export const VIEW_ONLY_REASON = 'Owner team set this repository to view only for your team';

/** Short form for a chip beside a repository the sharing team may read but not launch on. */
export const VIEW_ONLY_CHIP = 'View only';

interface Launchable {
  team?: TeamRef;
  shares?: Array<{ canLaunch?: boolean; team: TeamRef }>;
}

/**
 * Whether a repository is view only for the caller: they reach it only through teams it is shared
 * with, and every such share has `canLaunch` off. Owning the repository (being in its team), or
 * reaching it through any share that allows launching, is enough to launch. A platform ADMIN is
 * never held back. The server decides in the end; this only keeps the dashboard from offering
 * what it would refuse.
 *
 * `myTeamIds` is `null` while the caller's teams are loading, which answers false rather than
 * flashing a disabled option.
 */
export function isViewOnlyFor(
  repo: Launchable,
  myTeamIds: ReadonlySet<string> | null,
  platformAdmin: boolean
): boolean {
  if (platformAdmin || !myTeamIds) {
    return false;
  }
  if (repo.team && myTeamIds.has(repo.team.id)) {
    return false;
  }
  const reaching = (repo.shares ?? []).filter((s) => myTeamIds.has(s.team.id));
  return reaching.length > 0 && reaching.every((s) => s.canLaunch === false);
}

/** The owner named in launch-budget wording; the repository's owning team, else a neutral phrase. */
function budgetOwnerName(repo: { team?: TeamRef }): string {
  return repo.team?.name ?? 'the owning team';
}

/**
 * Why a repository cannot take new work because the budget that binds its launches is spent.
 * Names the owner and never an amount: the server is the authority and the dashboard only
 * previews. Null while the budget is under its cap, absent, or uncapped.
 */
export function launchBudgetReason(repo: {
  team?: TeamRef;
  launchBudget?: BudgetStatus | null;
}): string | null {
  if (repo.launchBudget?.state !== 'over') {
    return null;
  }
  // The organization's cap is the binding one: only an organization admin can lift it.
  if (repo.launchBudget.scope === 'org') {
    return "The organization's monthly budget is spent. Ask an organization admin.";
  }
  const owner = budgetOwnerName(repo);
  return `Over ${owner}'s budget this month. Ask ${owner}'s team lead.`;
}

/**
 * The small percent shown beside a repository in a launch picker, and whether it deserves a
 * warning tone. Null with no cap, no figure, or when the budget is over (the reason says so).
 */
export function launchBudgetHint(repo: {
  launchBudget?: BudgetStatus | null;
}): { text: string; warn: boolean } | null {
  const budget = repo.launchBudget;
  if (!budget || budget.state === 'no_cap' || budget.state === 'over') {
    return null;
  }
  if (budget.percentUsed === null) {
    return budget.state === 'ok' ? null : { text: 'Budget nearly used', warn: true };
  }
  return {
    text: `${Math.floor(budget.percentUsed)}% of budget used`,
    warn: budget.state === 'alert' || budget.state === 'projected_over',
  };
}
