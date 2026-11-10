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
