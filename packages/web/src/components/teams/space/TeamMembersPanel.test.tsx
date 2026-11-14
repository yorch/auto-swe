// @vitest-environment jsdom
import type { TeamSummary } from '@auto-swe/shared/types/api';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { TeamMembersPanel } from './TeamMembersPanel';

beforeEach(stubDialogPrototype);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const base: TeamSummary = {
  _count: { memberships: 1, repositories: 0 },
  defaultPersonaPrompt: null,
  description: '',
  id: 't1',
  myRole: 'LEAD',
  name: 'Payments',
  orgId: 'o1',
  orgName: 'Acme',
  slug: 'payments',
};
describe('team member onboarding gates', () => {
  it.each([
    ['LEAD', 'LEAD', true],
    ['ADMIN', null, true],
    ['ENGINEER', 'LEAD', true],
    ['ENGINEER', 'ADMIN', true],
    ['ENGINEER', 'ENGINEER', false],
    ['LEAD', 'ENGINEER', false],
  ] as const)('platform %s / team %s controls=%s', async (platformRole, myRole, expected) => {
    useAuthStore.setState({ user: { role: platformRole, sub: 'me' } });
    setupFetchMock({ '/api/v1/teams/t1': () => ({ data: { ...base, memberships: [] } }) });
    render(withQuery(<TeamMembersPanel team={{ ...base, myRole }} />));
    await screen.findByText('No members yet');
    expect(!!screen.queryByRole('button', { name: 'Add member' })).toBe(expected);
    expect(!!screen.queryByRole('button', { name: 'Invite by email' })).toBe(expected);
  });
});
