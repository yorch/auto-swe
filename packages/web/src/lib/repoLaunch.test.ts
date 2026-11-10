import type { BudgetStatus } from '@auto-swe/shared/types/api';
import { describe, expect, it } from 'vitest';
import { isViewOnlyFor, launchBudgetHint, launchBudgetReason } from './repoLaunch';

const t = (id: string) => ({ id, name: id, slug: id });
const mine = new Set(['pay']);

describe('isViewOnlyFor', () => {
  const shared = (canLaunch: boolean) => ({
    shares: [{ canLaunch, team: t('pay') }],
    team: t('own'),
  });

  it('is view only when every share reaching the caller forbids launching', () => {
    expect(isViewOnlyFor(shared(false), mine, false)).toBe(true);
    expect(isViewOnlyFor(shared(true), mine, false)).toBe(false);
  });
  it('treats a missing canLaunch as allowed', () => {
    expect(isViewOnlyFor({ shares: [{ team: t('pay') }], team: t('own') }, mine, false)).toBe(
      false
    );
  });
  it('is never view only for the owning team, a platform admin, or while teams load', () => {
    expect(
      isViewOnlyFor({ shares: [{ canLaunch: false, team: t('pay') }], team: t('pay') }, mine, false)
    ).toBe(false);
    expect(isViewOnlyFor(shared(false), mine, true)).toBe(false);
    expect(isViewOnlyFor(shared(false), null, false)).toBe(false);
  });
  it('lets a second team that may launch win', () => {
    const repo = {
      shares: [
        { canLaunch: false, team: t('pay') },
        { canLaunch: true, team: t('data') },
      ],
      team: t('own'),
    };
    expect(isViewOnlyFor(repo, new Set(['pay', 'data']), false)).toBe(false);
    expect(isViewOnlyFor(repo, mine, false)).toBe(true);
  });
  it('is not view only for a repository the caller reaches through no share', () => {
    expect(isViewOnlyFor({ shares: [], team: t('own') }, mine, false)).toBe(false);
  });
});

const budget = (state: BudgetStatus['state'], percentUsed: number | null): BudgetStatus => ({
  alertThresholdPercent: 80,
  percentUsed,
  scope: 'team',
  state,
});

describe('launch budget wording', () => {
  const owner = { id: 'o', name: 'Design', slug: 'design' };
  it('blocks only an over budget, naming the owner and no amount', () => {
    const reason = launchBudgetReason({ launchBudget: budget('over', 130), team: owner });
    expect(reason).toBe("Over Design's budget this month. Ask Design's team lead.");
    expect(reason).not.toMatch(/\d/);
    for (const state of ['ok', 'alert', 'projected_over', 'no_cap'] as const) {
      expect(launchBudgetReason({ launchBudget: budget(state, 90), team: owner })).toBeNull();
    }
    expect(launchBudgetReason({ launchBudget: null, team: owner })).toBeNull();
    expect(launchBudgetReason({ team: owner })).toBeNull();
  });
  it("points at an organization admin when the organization's cap is the spent one", () => {
    const reason = launchBudgetReason({
      launchBudget: { ...budget('over', 130), scope: 'org' },
      team: owner,
    });
    expect(reason).toBe("The organization's monthly budget is spent. Ask an organization admin.");
    expect(reason).not.toMatch(/\d|Design/);
  });
  it('falls back to a neutral owner without a team', () => {
    expect(launchBudgetReason({ launchBudget: budget('over', 100) })).toContain(
      "the owning team's budget"
    );
  });
  it('shows a floored percent, warning when nearing or projected over', () => {
    expect(launchBudgetHint({ launchBudget: budget('ok', 49.9) })).toEqual({
      text: '49% of budget used',
      warn: false,
    });
    expect(launchBudgetHint({ launchBudget: budget('alert', 85) })?.warn).toBe(true);
    expect(launchBudgetHint({ launchBudget: budget('projected_over', 70) })?.warn).toBe(true);
    expect(launchBudgetHint({ launchBudget: budget('over', 120) })).toBeNull();
    expect(launchBudgetHint({ launchBudget: budget('no_cap', null) })).toBeNull();
    expect(launchBudgetHint({ launchBudget: null })).toBeNull();
  });
});
