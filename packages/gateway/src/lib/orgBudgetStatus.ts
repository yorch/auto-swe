/**
 * An organization's budget as an engineer may see it: a state and a percentage, never an amount.
 *
 * The state comes from the same forecast the budget report uses, with one difference: `over` is
 * the launch gate's own condition (spend at or past the cap, `isOrgOverBudget`), so a status that
 * says `over` is exactly a status whose launches are refused with `ORG_BUDGET_EXCEEDED`.
 */
import type { PrismaClient } from '@auto-swe/shared';
import { orgMonthSpend } from '@auto-swe/shared/lib/billing';
import { budgetStatusFor, type OrgBudgetInputs } from '@auto-swe/shared/lib/budgetStatus';
import type { BudgetStatus } from '@auto-swe/shared/types/api';

export { budgetStatusFor, type OrgBudgetInputs };

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
