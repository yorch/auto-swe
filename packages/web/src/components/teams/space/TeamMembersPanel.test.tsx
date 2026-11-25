// @vitest-environment jsdom
import type { TeamSummary } from '@auto-swe/shared/types/api';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import {
  ADMIN_PERMISSIONS,
  NO_PERMISSIONS,
  permissionsFor,
  resetPermissions,
  setNarrowedPermissions,
  setPermissions,
} from '@/test/permissions';
import { gatewayError, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { TeamMembersPanel } from './TeamMembersPanel';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock('@/hooks/useEffectivePermissions', async () =>
  (await import('@/test/permissions')).permissionsMock()
);

beforeEach(() => {
  stubDialogPrototype();
  push.mockClear();
});
afterEach(() => {
  cleanup();
  resetPermissions();
  useAuthStore.setState({ isAuthenticated: false, user: null });
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

const MEMBERS = [
  {
    id: 'm1',
    role: 'MEMBER',
    user: { email: 'member@acme.com', id: 'u1', isActive: true, role: 'USER' },
  },
  {
    id: 'm2',
    role: 'ADMIN',
    user: { email: 'admin@acme.com', id: 'u2', isActive: true, role: 'USER' },
  },
];

const leadsTeam = permissionsFor({
  teams: [{ capabilities: ['team.members.manage'], role: 'LEAD', teamId: 't1' }],
});

describe('team member onboarding gates', () => {
  it.each([
    ['a team lead', leadsTeam, true],
    [
      'a team admin',
      permissionsFor({
        teams: [{ capabilities: ['team.members.manage'], role: 'ADMIN', teamId: 't1' }],
      }),
      true,
    ],
    ['a platform admin who is not a member', ADMIN_PERMISSIONS, true],
    [
      'a plain member',
      permissionsFor({ teams: [{ capabilities: [], role: 'MEMBER', teamId: 't1' }] }),
      false,
    ],
    ['a person with no standing', NO_PERMISSIONS, false],
  ] as const)('%s: controls=%s', async (_who, perms, expected) => {
    setPermissions(perms);
    setupFetchMock({ '/api/v1/teams/t1': () => ({ data: { ...base, memberships: [] } }) });
    render(withQuery(<TeamMembersPanel team={base} />));
    await screen.findByText('No members yet');
    expect(!!screen.queryByRole('button', { name: 'Add member' })).toBe(expected);
    expect(!!screen.queryByRole('button', { name: 'Invite by email' })).toBe(expected);
  });

  it('offers an organization admin who is not on the team the same controls, from the per-team answer', async () => {
    setPermissions(
      permissionsFor({
        orgs: [{ capabilities: ['org.members.manage'], orgId: 'o1', role: 'ADMIN' }],
      })
    );
    setNarrowedPermissions(
      't1',
      permissionsFor({
        teams: [
          {
            authority: 'org-admin',
            capabilities: ['team.members.manage'],
            role: null,
            teamId: 't1',
          },
        ],
      })
    );
    setupFetchMock({ '/api/v1/teams/t1': () => ({ data: { ...base, memberships: [] } }) });
    render(withQuery(<TeamMembersPanel team={{ ...base, myRole: null }} />));
    await screen.findByText('No members yet');
    expect(screen.getByRole('button', { name: 'Add member' })).toBeTruthy();
  });
});

describe('team roles in the member list', () => {
  it('labels each member with their team role', async () => {
    setPermissions(leadsTeam);
    setupFetchMock({ '/api/v1/teams/t1': () => ({ data: { ...base, memberships: MEMBERS } }) });
    render(withQuery(<TeamMembersPanel team={base} />));
    await screen.findByText('member@acme.com');
    // A lead may change a member's role up to their own, and not an admin's.
    expect(screen.getByRole('button', { name: /Team role for member@acme.com/ })).toBeTruthy();
    expect(screen.getByText('Team admin')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Team role for admin@acme.com/ })).toBeNull();
  });

  it('offers a lead only the roles up to lead, and a platform admin all three', async () => {
    setPermissions(leadsTeam);
    setupFetchMock({ '/api/v1/teams/t1': () => ({ data: { ...base, memberships: MEMBERS } }) });
    const first = render(withQuery(<TeamMembersPanel team={base} />));
    await screen.findByText('member@acme.com');
    fireEvent.click(screen.getByRole('button', { name: /Team role for member@acme.com/ }));
    expect(screen.getByRole('option', { name: 'Team lead' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Team admin' })).toBeNull();
    first.unmount();

    setPermissions(ADMIN_PERMISSIONS);
    render(withQuery(<TeamMembersPanel team={{ ...base, myRole: null }} />));
    await screen.findByText('member@acme.com');
    fireEvent.click(screen.getByRole('button', { name: /Team role for member@acme.com/ }));
    expect(screen.getByRole('option', { name: 'Team admin' })).toBeTruthy();
  });
});

describe('rows the server would refuse', () => {
  const rows = [
    ...MEMBERS,
    {
      id: 'm3',
      role: 'LEAD',
      user: { email: 'me@acme.com', id: 'me', isActive: true, role: 'USER' },
    },
  ];
  const showFor = async (perms: ReturnType<typeof permissionsFor>) => {
    setPermissions(perms);
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'USER', sub: 'me' } as never });
    setupFetchMock({ '/api/v1/teams/t1': () => ({ data: { ...base, memberships: rows } }) });
    render(withQuery(<TeamMembersPanel team={base} />));
    await screen.findByText('member@acme.com');
  };

  it('offers a lead no removal of themselves or of an admin, and no role change on their own row', async () => {
    await showFor(leadsTeam);
    expect(screen.getByRole('button', { name: 'More actions for member@acme.com' })).toBeTruthy();
    // The own row offers leaving, not removal.
    fireEvent.click(screen.getByRole('button', { name: 'More actions for me@acme.com' }));
    expect(screen.getByRole('menuitem', { name: 'Leave team' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Remove from team' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More actions for admin@acme.com' })).toBeNull();
    // A lead cannot raise themselves above lead, so the own row is a plain badge.
    expect(screen.queryByRole('button', { name: /Team role for me@acme.com/ })).toBeNull();
  });

  it('offers an admin on the team a raise-only select on their own row: none, as nothing is above', async () => {
    const adminRows = [
      {
        id: 'm4',
        role: 'ADMIN',
        user: { email: 'me@acme.com', id: 'me', isActive: true, role: 'USER' },
      },
      ...MEMBERS,
    ];
    setPermissions(
      permissionsFor({
        teams: [{ capabilities: ['team.members.manage'], role: 'ADMIN', teamId: 't1' }],
      })
    );
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'USER', sub: 'me' } as never });
    setupFetchMock({ '/api/v1/teams/t1': () => ({ data: { ...base, memberships: adminRows } }) });
    render(withQuery(<TeamMembersPanel team={base} />));
    await screen.findByText('member@acme.com');
    expect(screen.queryByRole('button', { name: /Team role for me@acme.com/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'More actions for me@acme.com' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'More actions for admin@acme.com' })).toBeTruthy();
  });

  it('offers a platform admin who sits on the team only a raise on their own row', async () => {
    setPermissions(ADMIN_PERMISSIONS);
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'ADMIN', sub: 'me' } as never });
    const own = [
      {
        id: 'm5',
        role: 'LEAD',
        user: { email: 'me@acme.com', id: 'me', isActive: true, role: 'ADMIN' },
      },
    ];
    setupFetchMock({ '/api/v1/teams/t1': () => ({ data: { ...base, memberships: own } }) });
    render(withQuery(<TeamMembersPanel team={base} />));
    await screen.findByText('me@acme.com');
    fireEvent.click(screen.getByRole('button', { name: /Team role for me@acme.com/ }));
    expect(screen.getByRole('option', { name: 'Team admin' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Member' })).toBeNull();
  });

  it('tells a plain member who manages members', async () => {
    setPermissions(permissionsFor({ teams: [{ capabilities: [], role: 'MEMBER', teamId: 't1' }] }));
    setupFetchMock({ '/api/v1/teams/t1': () => ({ data: { ...base, memberships: MEMBERS } }) });
    render(withQuery(<TeamMembersPanel team={base} />));
    await screen.findByText('member@acme.com');
    expect(screen.getByText('Team leads and admins manage members.')).toBeTruthy();
  });
});

describe('leaving the team', () => {
  const rows = [
    ...MEMBERS,
    {
      id: 'm3',
      role: 'MEMBER',
      user: { email: 'me@acme.com', id: 'me', isActive: true, role: 'USER' },
    },
  ];
  const memberOnly = permissionsFor({
    teams: [{ capabilities: [], role: 'MEMBER', teamId: 't1' }],
  });
  const open = async (leave: () => unknown) => {
    setPermissions(memberOnly);
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'USER', sub: 'me' } as never });
    const spy = setupFetchMock({
      '/api/v1/teams/t1': () => ({ data: { ...base, memberships: rows } }),
      'DELETE /api/v1/teams/t1/members/me': leave,
    });
    render(withQuery(<TeamMembersPanel team={base} />));
    await screen.findByText('member@acme.com');
    fireEvent.click(screen.getByRole('button', { name: 'More actions for me@acme.com' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Leave team' }));
    return spy;
  };

  it('offers a plain member leaving on their own row only', async () => {
    setPermissions(memberOnly);
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'USER', sub: 'me' } as never });
    setupFetchMock({ '/api/v1/teams/t1': () => ({ data: { ...base, memberships: rows } }) });
    render(withQuery(<TeamMembersPanel team={base} />));
    await screen.findByText('member@acme.com');
    expect(screen.getAllByRole('button', { name: /More actions for/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'More actions for me@acme.com' })).toBeTruthy();
  });

  it('tells an organization admin on the team that they keep access through the organization', async () => {
    await open(() => ({ data: { removed: true } }));
    expect(screen.getByText(/You will lose access to Payments/)).toBeTruthy();
    cleanup();
    setPermissions(
      permissionsFor({
        orgs: [{ capabilities: ['org.members.manage'], orgId: base.orgId as string }],
        teams: [{ capabilities: [], role: 'MEMBER', teamId: 't1' }],
      })
    );
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'USER', sub: 'me' } as never });
    setupFetchMock({ '/api/v1/teams/t1': () => ({ data: { ...base, memberships: rows } }) });
    render(withQuery(<TeamMembersPanel team={base} />));
    await screen.findByText('member@acme.com');
    fireEvent.click(screen.getByRole('button', { name: 'More actions for me@acme.com' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Leave team' }));
    expect(screen.queryByText(/You will lose access/)).toBeNull();
    expect(screen.getByText(/You keep access to it through your organization/)).toBeTruthy();
  });

  it('leaves after confirming and goes back to the teams list', async () => {
    const spy = await open(() => ({ data: { removed: true } }));
    fireEvent.click(await screen.findByRole('button', { name: 'Leave team' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/teams'));
    const call = spy.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'DELETE');
    expect(String(call?.[0])).toContain('/api/v1/teams/t1/members/me');
  });

  it("shows the server's refusal for the last admin and stays on the page", async () => {
    await open(() =>
      gatewayError(
        409,
        'LAST_TEAM_ADMIN',
        'You are the only admin of this team. Make another member an admin before you leave.'
      )
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Leave team' }));
    expect(await screen.findByText(/Make another member an admin before you leave/)).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });
});

describe('the platform role in the member list', () => {
  it('shows it when the server sends it and not when it is absent', async () => {
    setPermissions(leadsTeam);
    const { role: _omitted, ...bare } = MEMBERS[1].user;
    setupFetchMock({
      '/api/v1/teams/t1': () => ({
        data: { ...base, memberships: [MEMBERS[0], { ...MEMBERS[1], user: bare }] },
      }),
    });
    render(withQuery(<TeamMembersPanel team={base} />));
    await screen.findByText('member@acme.com');
    expect(screen.getAllByText(/Platform role:/)).toHaveLength(1);
  });
});
