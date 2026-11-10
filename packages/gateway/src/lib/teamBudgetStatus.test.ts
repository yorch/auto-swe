import type { BudgetStatus } from '@auto-swe/shared/types/api';
import { describe, expect, it, vi } from 'vitest';
import { budgetStatusFor } from './orgBudgetStatus.js';
import { bindingBudgetStatuses, tighterBudgetStatus } from './teamBudgetStatus.js';

vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/billingMock.js')),
}));

const MID_MONTH = new Date('2026-06-16T00:00:00Z');
const status = (
  scope: 'org' | 'team',
  percentUsed: number | null,
  state: BudgetStatus['state']
): BudgetStatus => ({ alertThresholdPercent: null, percentUsed, scope, state });

describe('tighterBudgetStatus', () => {
  it('picks the cap with the larger share used and keeps its scope', () => {
    expect(tighterBudgetStatus(status('org', 40, 'ok'), status('team', 90, 'alert'))?.scope).toBe(
      'team'
    );
    expect(tighterBudgetStatus(status('org', 90, 'alert'), status('team', 40, 'ok'))?.scope).toBe(
      'org'
    );
  });

  it('uses the only cap there is, and no_cap when neither is set', () => {
    const noCap = status('org', null, 'no_cap');
    expect(tighterBudgetStatus(status('org', 10, 'ok'), undefined)?.scope).toBe('org');
    expect(tighterBudgetStatus(noCap, status('team', 10, 'ok'))?.scope).toBe('team');
    expect(tighterBudgetStatus(noCap, undefined)).toEqual(noCap);
    expect(tighterBudgetStatus(undefined, undefined)).toBeNull();
  });

  it('breaks an equal share by severity, then in favour of the team', () => {
    expect(tighterBudgetStatus(status('org', 100, 'over'), status('team', 100, 'ok'))?.scope).toBe(
      'org'
    );
    expect(tighterBudgetStatus(status('org', 50, 'ok'), status('team', 50, 'ok'))?.scope).toBe(
      'team'
    );
  });
});

describe('budgetStatusFor with a team scope', () => {
  const at = (cap: number | null, usd: number, threshold: number | null = null, now = MID_MONTH) =>
    budgetStatusFor(
      { budgetAlertThresholdPercent: threshold, monthlyBudgetUsdCents: cap },
      usd,
      now,
      'team'
    );

  it('carries the team scope on every state', () => {
    expect(at(null, 5).scope).toBe('team');
    expect(at(10_000, 1).scope).toBe('team');
  });

  it('reads a zero cap as full and over, whatever was spent', () => {
    expect(at(0, 0)).toMatchObject({ percentUsed: 100, state: 'over' });
  });

  it('is over exactly at the cap and not a cent before', () => {
    expect(at(10_000, 99.99).state).not.toBe('over');
    expect(at(10_000, 100)).toMatchObject({ percentUsed: 100, state: 'over' });
  });

  it('alerts at the threshold boundary while on pace', () => {
    // Half the month elapsed: $40 projects to $80, under the $100 cap.
    expect(at(10_000, 39.99, 40).state).toBe('ok');
    expect(at(10_000, 40, 40).state).toBe('alert');
  });

  it('does not project an overrun from the first half hour of the month', () => {
    const early = new Date('2026-12-01T00:30:00Z');
    expect(at(10_000, 1, null, early).state).toBe('ok');
  });
});

describe('bindingBudgetStatuses', () => {
  it('reads every team once and gives each the tighter of its own and its organization cap', async () => {
    const prisma = {
      organization: {
        findMany: vi.fn(async () => [
          { budgetAlertThresholdPercent: null, id: 'o1', monthlyBudgetUsdCents: 100_000 },
        ]),
      },
      orgMonthlyUsage: { findUnique: vi.fn(async () => ({ costUsdAccrued: 100 })) },
      team: {
        findMany: vi.fn(async () => [
          { budgetAlertThresholdPercent: null, id: 't1', monthlyBudgetUsdCents: 1000 },
          { budgetAlertThresholdPercent: null, id: 't2', monthlyBudgetUsdCents: null },
        ]),
      },
      teamSpendUsd: { t1: 5 },
    };
    const result = await bindingBudgetStatuses(
      prisma as never,
      [
        { id: 't1', orgId: 'o1' },
        { id: 't2', orgId: 'o1' },
      ],
      MID_MONTH
    );
    expect(result.get('t1')).toMatchObject({ percentUsed: 50, scope: 'team' });
    expect(result.get('t2')).toMatchObject({ percentUsed: 10, scope: 'org' });
    expect(prisma.team.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.organization.findMany).toHaveBeenCalledTimes(1);
  });
});
