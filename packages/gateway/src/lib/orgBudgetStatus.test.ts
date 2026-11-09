import { describe, expect, it, vi } from 'vitest';
import { budgetStatusFor, orgBudgetStatuses } from './orgBudgetStatus.js';

vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/billingMock.js')),
}));

const MID_MONTH = new Date('2026-06-16T00:00:00Z');

describe('budgetStatusFor', () => {
  it('reports no_cap with no percentage when the org has no cap', () => {
    expect(
      budgetStatusFor(
        { budgetAlertThresholdPercent: 80, monthlyBudgetUsdCents: null },
        500,
        MID_MONTH
      )
    ).toEqual({ alertThresholdPercent: 80, percentUsed: null, scope: 'org', state: 'no_cap' });
  });

  it('is ok below the alert threshold and on pace', () => {
    const s = budgetStatusFor(
      { budgetAlertThresholdPercent: 80, monthlyBudgetUsdCents: 100_000 },
      100,
      MID_MONTH
    );
    expect(s).toMatchObject({ percentUsed: 10, state: 'ok' });
  });

  it('is alert at or past the threshold while still on pace', () => {
    // Half the month elapsed: $450 projects to $900, under the $1000 cap, past the 40% line.
    const s = budgetStatusFor(
      { budgetAlertThresholdPercent: 40, monthlyBudgetUsdCents: 100_000 },
      450,
      MID_MONTH
    );
    expect(s).toMatchObject({ alertThresholdPercent: 40, percentUsed: 45, state: 'alert' });
  });

  it('is projected_over when the pace exceeds the cap before spend does', () => {
    const s = budgetStatusFor(
      { budgetAlertThresholdPercent: null, monthlyBudgetUsdCents: 10_000 },
      80,
      MID_MONTH
    );
    expect(s.state).toBe('projected_over');
  });

  it('does not project an overrun from the first half hour of the month', () => {
    const early = new Date('2026-12-01T00:30:00Z');
    expect(
      budgetStatusFor({ budgetAlertThresholdPercent: 80, monthlyBudgetUsdCents: 100_000 }, 1, early)
        .state
    ).toBe('ok');
    // Past the alert threshold the fallback is the alert, still not a projection.
    expect(
      budgetStatusFor(
        { budgetAlertThresholdPercent: 0.05, monthlyBudgetUsdCents: 100_000 },
        1,
        early
      ).state
    ).toBe('alert');
  });

  it('is over exactly when the launch gate refuses: spend at or past the cap', () => {
    const at = budgetStatusFor(
      { budgetAlertThresholdPercent: null, monthlyBudgetUsdCents: 1000 },
      10,
      MID_MONTH
    );
    expect(at).toMatchObject({ percentUsed: 100, state: 'over' });
    const past = budgetStatusFor(
      { budgetAlertThresholdPercent: null, monthlyBudgetUsdCents: 1000 },
      12.5,
      MID_MONTH
    );
    expect(past).toMatchObject({ percentUsed: 125, state: 'over' });
  });

  it('treats a zero cap as full', () => {
    expect(
      budgetStatusFor({ budgetAlertThresholdPercent: null, monthlyBudgetUsdCents: 0 }, 0, MID_MONTH)
    ).toMatchObject({ percentUsed: 100, state: 'over' });
  });

  it('carries no dollar fields', () => {
    const s = budgetStatusFor(
      { budgetAlertThresholdPercent: 80, monthlyBudgetUsdCents: 1000 },
      5,
      MID_MONTH
    );
    expect(Object.keys(s).sort()).toEqual([
      'alertThresholdPercent',
      'percentUsed',
      'scope',
      'state',
    ]);
  });
});

describe('orgBudgetStatuses', () => {
  const prisma = (orgs: unknown[], usage: Record<string, number> = {}) => {
    const findMany = vi.fn().mockResolvedValue(orgs);
    return {
      findMany,
      prisma: {
        organization: { findMany },
        orgMonthlyUsage: {
          findUnique: async (args: { where: { orgId_yearMonth: { orgId: string } } }) => {
            const cost = usage[args.where.orgId_yearMonth.orgId];
            return cost === undefined ? null : { costUsdAccrued: cost };
          },
        },
      } as never,
    };
  };

  it('reads the organizations once, for the distinct ids, and omits uncapped ones', async () => {
    const { findMany, prisma: db } = prisma(
      [
        { budgetAlertThresholdPercent: null, id: 'org-1', monthlyBudgetUsdCents: 1000 },
        { budgetAlertThresholdPercent: null, id: 'org-2', monthlyBudgetUsdCents: null },
      ],
      { 'org-1': 2 }
    );
    const map = await orgBudgetStatuses(db, ['org-1', 'org-2', 'org-1'], MID_MONTH);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({ id: { in: ['org-1', 'org-2'] } });
    expect([...map.keys()]).toEqual(['org-1']);
    expect(map.get('org-1')).toMatchObject({ percentUsed: 20, scope: 'org' });
  });

  it('reads nothing for no organizations', async () => {
    const { findMany, prisma: db } = prisma([]);
    expect((await orgBudgetStatuses(db, [])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
