import { describe, expect, it } from 'vitest';
import { groupedRepoOptions, groupReposByTeam } from './repoGroups';

const team = (id: string, name: string) => ({ id, name, slug: id });
const repo = (
  id: string,
  owner: { id: string; name: string; slug: string },
  shares: string[] = []
) => ({
  id,
  shares: shares.map((s) => ({ team: team(s, s) })),
  team: owner,
});

const payments = team('pay', 'Payments');
const platform = team('plat', 'Platform');
const data = team('data', 'Data');

describe('groupReposByTeam', () => {
  const repos = [
    repo('r-plat', platform, ['pay']),
    repo('r-data', data),
    repo('r-pay-1', payments),
    repo('r-pay-2', payments),
  ];

  it('puts the scope team’s own repositories first, then those shared with it, then the rest', () => {
    const groups = groupReposByTeam(repos, { id: 'pay', name: 'Payments' });
    expect(groups.map((g) => [g.label, g.repos.map((r) => r.id)])).toEqual([
      ['Payments', ['r-pay-1', 'r-pay-2']],
      ['Shared with Payments', ['r-plat']],
      ['Data', ['r-data']],
    ]);
  });

  it('groups by owning team, by name, without a scope', () => {
    const groups = groupReposByTeam(repos, null);
    expect(groups.map((g) => g.label)).toEqual(['Data', 'Payments', 'Platform']);
  });

  it('keeps a repository with no team instead of dropping it', () => {
    const groups = groupReposByTeam([{ id: 'x', team: undefined }, repo('y', data)], null);
    expect(groups.flatMap((g) => g.repos.map((r) => r.id)).sort()).toEqual(['x', 'y']);
  });

  it('turns groups into options carrying the group as their second line', () => {
    const options = groupedRepoOptions(repos, { id: 'pay', name: 'Payments' }, (r) => r.id);
    expect(options.map((o) => [o.value, o.description])).toEqual([
      ['r-pay-1', 'Payments'],
      ['r-pay-2', 'Payments'],
      ['r-plat', 'Shared with Payments'],
      ['r-data', 'Data'],
    ]);
    expect(options[2]?.textValue).toContain('Shared with Payments');
  });
});

describe('groupedRepoOptions blocked reasons', () => {
  it('lists a blocked repository disabled with its reason beside the group', () => {
    const options = groupedRepoOptions(
      [repo('a', payments), repo('b', platform)],
      null,
      (r) => r.id,
      (r) => (r.id === 'b' ? 'View only' : null)
    );
    const b = options.find((o) => o.value === 'b');
    expect(b).toMatchObject({ description: 'Platform · View only', disabled: true });
    expect(options.find((o) => o.value === 'a')).not.toHaveProperty('disabled');
  });
});

describe('groupedRepoOptions launch budgets', () => {
  const b = (state: 'ok' | 'alert' | 'over', percentUsed: number) => ({
    alertThresholdPercent: 80,
    percentUsed,
    scope: 'team' as const,
    state,
  });
  const repos = [
    { ...repo('r-ok', platform), launchBudget: b('ok', 40) },
    { ...repo('r-alert', platform), launchBudget: b('alert', 88) },
    { ...repo('r-over', platform), launchBudget: b('over', 120) },
    { ...repo('r-none', platform), launchBudget: null },
  ];
  const options = groupedRepoOptions(repos, null, (r) => r.id);
  const by = (id: string) => options.find((o) => o.value === id);

  it('shows the percent, warning-toned when nearing, and leaves it selectable', () => {
    expect(by('r-ok')?.description).toBe('Platform · 40% of budget used');
    expect(by('r-ok')).not.toHaveProperty('disabled');
    expect(by('r-alert')?.description).toBe('Platform · 88% of budget used');
    expect(by('r-alert')).toMatchObject({ tone: 'warning' });
    expect(by('r-alert')).not.toHaveProperty('disabled');
  });
  it('disables an over-budget repository with the reason and no amount', () => {
    expect(by('r-over')).toMatchObject({
      description: "Platform · Over Platform's budget this month. Ask Platform's team lead.",
      disabled: true,
    });
  });
  it('is unchanged without a budget', () => {
    expect(by('r-none')?.description).toBe('Platform');
  });
});
