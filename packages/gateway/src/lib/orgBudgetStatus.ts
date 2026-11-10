/**
 * An organization's budget as an engineer may see it: a state and a percentage, never an amount.
 *
 * The state comes from the same forecast the budget report uses, with one difference: `over` is
 * the launch gate's own condition (spend at or past the cap, `isOrgOverBudget`), so a status that
 * says `over` is exactly a status whose launches are refused with `ORG_BUDGET_EXCEEDED`.
 */
import type { PrismaClient } from '@auto-swe/shared';
import { orgMonthSpend, usdToCents } from '@auto-swe/shared/lib/billing';
import { forecastMonthlyBudget } from '@auto-swe/shared/lib/budgetForecast';
import type { BudgetStatus } from '@auto-swe/shared/types/api';

export interface OrgBudgetInputs {
  monthlyBudgetUsdCents: number | null;
  budgetAlertThresholdPercent: number | null;
}

/**
 * The status for one cap, threshold and month-to-date spend. Pure, and the one core an
 * organization's and a team's status share: only `scope` differs.
 */
export function budgetStatusFor(
  org: OrgBudgetInputs,
  spendUsd: number,
  now: Date,
  scope: BudgetStatus['scope'] = 'org'
): BudgetStatus {
  const cap = org.monthlyBudgetUsdCents;
  if (cap == null) {
    return {
      alertThresholdPercent: org.budgetAlertThresholdPercent,
      percentUsed: null,
      scope,
      state: 'no_cap',
    };
  }
  const spentCents = usdToCents(spendUsd);
  // A zero cap refuses every launch, so it reads as full whatever has been spent.
  const percentUsed = cap <= 0 ? 100 : Math.round((spentCents / cap) * 1000) / 10;
  const forecast = forecastMonthlyBudget({
    alertThresholdPercent: org.budgetAlertThresholdPercent,
    monthlyBudgetUsdCents: cap,
    now,
    spendUsd,
  });
  let state = forecast.status;
  // Inside the first day of the month a pace is an extrapolation from hours of spend: $1 at half
  // past midnight "projects" past a $1000 cap. Without a trustworthy pace the state falls back to
  // what is known, the alert threshold.
  if (state === 'projected_over' && forecast.lowConfidence) {
    state =
      forecast.alertThresholdUsd !== null && spendUsd >= forecast.alertThresholdUsd
        ? 'alert'
        : 'ok';
  }
  if (spentCents >= cap) {
    state = 'over';
  }
  return {
    alertThresholdPercent: org.budgetAlertThresholdPercent,
    percentUsed,
    scope,
    state,
  };
}

/**
 * The status of every named organization, in one read of the organizations and one spend read per
 * organization that has a cap. An organization with no cap is absent from the map.
 */
export async function orgBudgetStatuses(
  prisma: PrismaClient,
  orgIds: readonly string[],
  now: Date = new Date()
): Promise<Map<string, BudgetStatus>> {
  const result = new Map<string, BudgetStatus>();
  const ids = [...new Set(orgIds)];
  if (ids.length === 0) {
    return result;
  }
  const orgs = await prisma.organization.findMany({
    select: { budgetAlertThresholdPercent: true, id: true, monthlyBudgetUsdCents: true },
    where: { id: { in: ids } },
  });
  await Promise.all(
    orgs
      .filter((org) => org.monthlyBudgetUsdCents != null)
      .map(async (org) => {
        const spend = await orgMonthSpend(prisma, org.id);
        result.set(org.id, budgetStatusFor(org, spend.totalUsd, now));
      })
  );
  return result;
}
