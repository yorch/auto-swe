// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamSpaceProvider } from '@/components/teams/space/TeamSpaceContext';
import {
  ADMIN_PERMISSIONS,
  NO_PERMISSIONS,
  type OrgStanding,
  permissionsFor,
  resetPermissions,
  setPermissions,
} from '@/test/permissions';
import { withQuery } from '@/test/rtl-helpers';
import TeamManagePage from './page';

vi.mock('@/app/not-found', () => ({ default: () => <p>Page not found</p> }));
vi.mock('@/components/teams/space/TeamManagePanel', () => ({
  TeamManagePanel: () => <p>manage panel</p>,
}));
vi.mock('@/hooks/useEffectivePermissions', async () =>
  (await import('@/test/permissions')).permissionsMock()
);

afterEach(() => {
  cleanup();
  resetPermissions();
});

const team = (myRole: 'ADMIN' | 'LEAD' | 'MEMBER' | null) => ({
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

const leads = permissionsFor({
  teams: [{ capabilities: ['team.attention.read'], role: 'LEAD', teamId: 'team-1' }],
});
const member = permissionsFor({ teams: [{ capabilities: [], role: 'MEMBER', teamId: 'team-1' }] });
const orgAdminOnly: OrgStanding = {
  capabilities: ['org.budget.manage'],
  orgId: 'org-1',
  role: 'ADMIN',
};

function renderPage(
  perms: Parameters<typeof setPermissions>[0],
  myRole: 'ADMIN' | 'LEAD' | 'MEMBER' | null
) {
  setPermissions(perms);
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
  it('answers the not-found page for a team member', () => {
    renderPage(member, 'MEMBER');
    expect(screen.getByText('Page not found')).toBeTruthy();
    expect(screen.queryByText('manage panel')).toBeNull();
  });

  it('answers the not-found page for someone the server describes nothing for', () => {
    renderPage(NO_PERMISSIONS, null);
    expect(screen.getByText('Page not found')).toBeTruthy();
  });

  it('answers the not-found page for an organization admin who holds no lead capability here', () => {
    renderPage(permissionsFor({ orgs: [orgAdminOnly] }), null);
    expect(screen.getByText('Page not found')).toBeTruthy();
  });

  it('renders the panel for a team lead', () => {
    renderPage(leads, 'LEAD');
    expect(screen.getByText('manage panel')).toBeTruthy();
  });

  it('renders the panel for a platform admin who is not a member', () => {
    renderPage(ADMIN_PERMISSIONS, null);
    expect(screen.getByText('manage panel')).toBeTruthy();
  });
});
