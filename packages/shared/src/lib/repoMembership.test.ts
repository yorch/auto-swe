import { describe, expect, it } from 'vitest';
import {
  allRepoMemberships,
  isRepoMember,
  repoMembersSelect,
  repoMemberWhere,
} from './repoMembership.js';

const repo = {
  shares: [
    { team: { memberships: [{ userId: 'shared-1' }, { userId: 'both' }] } },
    { team: { memberships: [{ userId: 'shared-2' }] } },
  ],
  team: { memberships: [{ userId: 'owner-1' }, { userId: 'both' }] },
};

describe('repoMembership', () => {
  it('counts the owning team and every shared team', () => {
    for (const userId of ['owner-1', 'shared-1', 'shared-2', 'both']) {
      expect(isRepoMember(repo, userId), userId).toBe(true);
    }
    expect(isRepoMember(repo, 'stranger')).toBe(false);
  });

  it('lists every membership, owning team first', () => {
    expect(allRepoMemberships(repo).map((m) => m.userId)).toEqual([
      'owner-1',
      'both',
      'shared-1',
      'both',
      'shared-2',
    ]);
  });

  it('selects the same memberships from both relations', () => {
    expect(repoMembersSelect({ userId: true }, { userId: 'u' })).toEqual({
      shares: {
        select: {
          team: { select: { memberships: { select: { userId: true }, where: { userId: 'u' } } } },
        },
      },
      team: { select: { memberships: { select: { userId: true }, where: { userId: 'u' } } } },
    });
  });

  it('matches a repository through either relation', () => {
    expect(repoMemberWhere({ userId: 'u' })).toEqual({
      OR: [
        { team: { memberships: { some: { userId: 'u' } } } },
        { shares: { some: { team: { memberships: { some: { userId: 'u' } } } } } },
      ],
    });
  });
});
