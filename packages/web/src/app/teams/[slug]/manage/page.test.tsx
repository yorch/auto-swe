// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamSpaceProvider } from '@/components/teams/space/TeamSpaceContext';
import { useAuthStore } from '@/stores/authStore';
import { withQuery } from '@/test/rtl-helpers';
import TeamManagePage from './page';

vi.mock('@/app/not-found', () => ({ default: () => <p>Page not found</p> }));
vi.mock('@/components/teams/space/TeamManagePanel', () => ({
  TeamManagePanel: () => <p>manage panel</p>,
}));

afterEach(() => {
  cleanup();
  useAuthStore.setState({ isAuthenticated: false, user: null });
});

const team = (myRole: 'ADMIN' | 'LEAD' | 'ENGINEER' | null) => ({
  _count: { memberships: 1, repositories: 1 },
  defaultPersonaPrompt: null,
  description: '',
  id: 'team-1',
  myRole,
  name: 'Payments',
  orgId: 'org-1',
  orgName: 'Acme',
  slug: 'payments',
});

function renderPage(platformRole: string, myRole: 'ADMIN' | 'LEAD' | 'ENGINEER' | null) {
  useAuthStore.setState({ isAuthenticated: true, user: { role: platformRole, sub: 'me' } });
  render(
    withQuery(
      <TeamSpaceProvider
        value={{ canManageBudget: false, canSeeSettings: false, team: team(myRole) }}
      >
        <TeamManagePage />
      </TeamSpaceProvider>
    )
  );
}

describe('team Manage page', () => {
  it('answers the not-found page for an engineer', () => {
    renderPage('ENGINEER', 'ENGINEER');
    expect(screen.getByText('Page not found')).toBeTruthy();
    expect(screen.queryByText('manage panel')).toBeNull();
  });

  it('answers the not-found page for a platform LEAD who is only an engineer on the team', () => {
    renderPage('LEAD', 'ENGINEER');
    expect(screen.getByText('Page not found')).toBeTruthy();
  });

  it('renders the panel for a team lead', () => {
    renderPage('ENGINEER', 'LEAD');
    expect(screen.getByText('manage panel')).toBeTruthy();
  });

  it('renders the panel for a platform ADMIN who is not a member', () => {
    renderPage('ADMIN', null);
    expect(screen.getByText('manage panel')).toBeTruthy();
  });
});
