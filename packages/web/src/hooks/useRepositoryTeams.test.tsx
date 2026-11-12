// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const actor = vi.hoisted(() => ({ orgRole: 'ORG_MEMBER', role: 'ENGINEER' }));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (select: (s: { user: { role: string } }) => unknown) =>
    select({ user: { role: actor.role } }),
}));
vi.mock('./useAdmin', () => ({
  useUserOrgs: () => ({ data: [{ id: 'o1', role: actor.orgRole }] }),
}));
vi.mock('./useTeams', () => ({
  useTeams: () => ({
    data: [
      { id: 'led', isActive: true, myRole: 'LEAD', orgId: 'o2' },
      { id: 'org', isActive: true, myRole: null, orgId: 'o1' },
      { id: 'other', isActive: true, myRole: 'ENGINEER', orgId: 'o2' },
    ],
  }),
}));

import { useRepositoryTeams } from './useRepositoryTeams';

describe('repository team picker', () => {
  it.each([
    ['ENGINEER', 'ORG_MEMBER', ['led']],
    ['ENGINEER', 'ORG_ADMIN', ['led', 'org']],
    ['ADMIN', 'ORG_MEMBER', ['led', 'org', 'other']],
  ])('filters active teams for %s / %s', (role, orgRole, ids) => {
    actor.role = role as string;
    actor.orgRole = orgRole as string;
    const { result } = renderHook(() => useRepositoryTeams());
    expect(result.current.map((t) => t.id)).toEqual(ids);
  });
});
