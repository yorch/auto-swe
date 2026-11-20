// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The teams the server says the caller holds `team.repos.create` on.
const held = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('./useCan', () => ({
  useCanOnTeams: () => (teamId: string) => held.ids.includes(teamId),
}));
// One array, as a query result keeps its identity between renders.
const TEAMS = vi.hoisted(() => [
  { id: 'led', isActive: true, myRole: 'LEAD', orgId: 'o2' },
  { id: 'org', isActive: true, myRole: null, orgId: 'o1' },
  { id: 'other', isActive: true, myRole: 'MEMBER', orgId: 'o2' },
]);
vi.mock('./useTeams', () => ({ useTeams: () => ({ data: TEAMS }) }));

import { useRepositoryTeams } from './useRepositoryTeams';

describe('repository team picker', () => {
  it.each([
    ['a team lead', ['led'], ['led']],
    ['an org admin of the owning org and a lead', ['led', 'org'], ['led', 'org']],
    ['a platform admin', ['led', 'org', 'other'], ['led', 'org', 'other']],
    ['a member', [], []],
  ])('lists the teams the server lets %s create a connection in', (_who, ids, expected) => {
    held.ids = ids;
    const { result } = renderHook(() => useRepositoryTeams());
    expect(result.current.map((t) => t.id)).toEqual(expected);
  });

  it('keeps the same list while the answer does not change', () => {
    held.ids = ['led'];
    const { result, rerender } = renderHook(() => useRepositoryTeams());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
