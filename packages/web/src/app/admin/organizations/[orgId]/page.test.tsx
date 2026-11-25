// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import {
  ADMIN_PERMISSIONS,
  permissionsFor,
  resetPermissions,
  setPermissions,
} from '@/test/permissions';
import {
  bodyOf,
  gatewayError,
  setupFetchMock,
  stubDialogPrototype,
  withQuery,
} from '@/test/rtl-helpers';
import OrgAdminPage from './page';

vi.mock('@/hooks/useEffectivePermissions', async () =>
  (await import('@/test/permissions')).permissionsMock()
);
vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/organizations/11111111-1111-4111-8111-111111111111',
  useRouter: () => ({ push: vi.fn() }),
}));

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const params = Object.assign(Promise.resolve({ orgId: ORG_ID }), {
  status: 'fulfilled',
  value: { orgId: ORG_ID },
});

// What the server says the caller holds in this organization.
const ORG_ADMIN = permissionsFor({
  orgs: [
    {
      capabilities: [
        'org.read',
        'org.members.manage',
        'org.budget.manage',
        'org.settings.manage',
        'org.teams.create',
        'org.github.manage',
      ],
      orgId: ORG_ID,
      role: 'ADMIN',
    },
  ],
});
const ORG_MEMBER = permissionsFor({
  orgs: [{ capabilities: ['org.read'], orgId: ORG_ID, role: 'MEMBER' }],
});

const member = (userId: string, email: string, role: string) => ({
  createdAt: '2026-01-01T00:00:00.000Z',
  id: `m-${userId}`,
  orgId: ORG_ID,
  role,
  user: { email, id: userId, name: null, role: 'USER' },
  userId,
});

beforeEach(() => {
  stubDialogPrototype();
  useAuthStore.setState({ isAuthenticated: true, user: { role: 'USER', sub: 'me' } } as never);
  setPermissions(ORG_ADMIN);
});
afterEach(() => {
  cleanup();
  resetPermissions();
  vi.unstubAllGlobals();
});

function mock(
  members: ReturnType<typeof member>[],
  options: { isActive?: boolean; patch?: () => unknown } = {}
) {
  return setupFetchMock({
    [`GET /api/v1/platform/organizations/${ORG_ID}`]: () => ({
      data: {
        id: ORG_ID,
        isActive: options.isActive ?? true,
        name: 'Acme',
        slug: 'acme',
        trustedInvites: false,
      },
    }),
    [`GET /api/v1/platform/organizations/${ORG_ID}/budget`]: () => ({
      budgetAlertThresholdPercent: null,
      currentMonthSpend: { inFlightUsd: 0, runlessUsd: 0, totalUsd: 0 },
      currentMonthUsage: null,
      monthlyBudgetUsdCents: null,
    }),
    [`GET /api/v1/platform/organizations/${ORG_ID}/budget/status`]: () => ({
      data: { alertThresholdPercent: 80, percentUsed: 41.5, scope: 'org', state: 'ok' },
    }),
    [`GET /api/v1/platform/organizations/${ORG_ID}/members`]: () => ({ data: members }),
    [`PATCH /api/v1/platform/organizations/${ORG_ID}`]: options.patch ?? (() => ({ data: {} })),
    'GET /api/v1/teams': () => ({
      data: [
        { id: 't1', name: 'Payments', orgId: ORG_ID },
        { id: 't2', name: 'Foreign', orgId: 'other' },
      ],
    }),
    'GET /api/v1/users': () => ({ data: [] }),
    [`GET /api/v1/organizations/${ORG_ID}/github/installations`]: () => ({ data: [] }),
    [`POST /api/v1/platform/organizations/${ORG_ID}/members/invite`]: () => ({
      data: { email: 'new@acme.com', isActive: false },
    }),
  });
}

describe('organization admin page', () => {
  it('offers GitHub connections to an organization admin who is no platform admin', async () => {
    mock([member('me', 'me@x.com', 'ADMIN')]);
    render(withQuery(<OrgAdminPage params={params} />));
    expect(await screen.findByRole('button', { name: 'Connect a GitHub org' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New team' })).toBeTruthy();
    expect(await screen.findByText('No linked installations.')).toBeTruthy();
  });
  it('does not offer GitHub management to an ordinary organization member', async () => {
    setPermissions(ORG_MEMBER);
    mock([member('me', 'me@x.com', 'MEMBER')]);
    render(withQuery(<OrgAdminPage params={params} />));
    await screen.findByRole('heading', { name: 'Acme' });
    expect(screen.queryByRole('button', { name: 'Connect a GitHub org' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New team' })).toBeNull();
  });
  it('asks before trusting organization admin invites, and saves only on confirmation', async () => {
    // Deciding which email domains an organization trusts is a platform admin's.
    setPermissions(ADMIN_PERMISSIONS);
    const spy = mock([member('me', 'me@x.com', 'ADMIN')]);
    render(withQuery(<OrgAdminPage params={params} />));
    fireEvent.click(
      await screen.findByRole('switch', { name: 'Trust organization and team invites' })
    );
    expect(await screen.findByText('Trust organization and team invites?')).toBeTruthy();
    expect(spy.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'PATCH')).toBe(
      false
    );
    fireEvent.click(screen.getByRole('button', { name: 'Trust invites' }));
    await waitFor(() =>
      expect(bodyOf(spy, `/api/v1/platform/organizations/${ORG_ID}`, 'PATCH')).toEqual({
        trustedInvites: true,
      })
    );
  });

  it('keeps trust in invites from an organization admin who is no platform admin', async () => {
    mock([member('me', 'me@x.com', 'ADMIN')]);
    render(withQuery(<OrgAdminPage params={params} />));
    await screen.findByRole('heading', { name: 'Acme' });
    expect(
      screen.queryByRole('switch', { name: 'Trust organization and team invites' })
    ).toBeNull();
  });

  it('lets an organization admin change another member’s role, not their own', async () => {
    mock([member('me', 'me@x.com', 'ADMIN'), member('u3', 'plain@x.com', 'MEMBER')]);
    render(withQuery(<OrgAdminPage params={params} />));
    const select = await screen.findByRole('button', { name: /Org role for plain@x.com/ });
    expect((select as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: /Org role for me@x.com/ })).toBeNull();
    expect(screen.getByTitle('You cannot change your own role').textContent).toBe('Org admin');
  });

  it('shows an org member the percentage meter and never asks for the dollar budget', async () => {
    setPermissions(ORG_MEMBER);
    const spy = mock([member('me', 'me@x.com', 'MEMBER'), member('u2', 'a@x.com', 'ADMIN')]);
    render(withQuery(<OrgAdminPage params={params} />));
    expect(await screen.findByTestId('budget-meter')).toBeTruthy();
    expect(screen.getByText('41% of the org budget this month')).toBeTruthy();
    const urls = spy.mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => u.endsWith('/budget'))).toBe(false);
    expect(screen.queryByText('Save budget')).toBeNull();
  });

  it('keeps Save budget disabled until a value changes', async () => {
    mock([member('me', 'me@x.com', 'ADMIN')]);
    render(withQuery(<OrgAdminPage params={params} />));
    const save = (await screen.findByRole('button', { name: 'Save budget' })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Monthly cap'), { target: { value: '50' } });
    expect(save.disabled).toBe(false);
  });

  it('offers team creation to an org admin and sends optional invite team and role', async () => {
    const spy = mock([member('me', 'me@x.com', 'ADMIN')]);
    render(withQuery(<OrgAdminPage params={params} />));
    expect(await screen.findByRole('button', { name: 'New team' })).toBeTruthy();
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'new@acme.com' } });
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: /team \(optional\)/i }) as HTMLButtonElement).disabled
      ).toBe(false)
    );
    fireEvent.click(screen.getByRole('button', { name: /team \(optional\)/i }));
    expect(screen.queryByRole('option', { name: 'Foreign' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Payments' }));
    fireEvent.click(screen.getByRole('button', { name: /Team role/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Team lead' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    await screen.findByText(/wait in the platform approval queue/);
    expect(bodyOf(spy, `/organizations/${ORG_ID}/members/invite`)).toEqual({
      email: 'new@acme.com',
      orgRole: 'MEMBER',
      teamId: 't1',
      teamRole: 'LEAD',
    });
  });

  describe('organization status', () => {
    const urlOf = (spy: ReturnType<typeof mock>, method: string, suffix = '') =>
      spy.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith(`/api/v1/platform/organizations/${ORG_ID}${suffix}`) &&
          ((init as RequestInit | undefined)?.method ?? 'GET') === method
      );

    it('shows an active organization to a member, with no control to change it', async () => {
      setPermissions(ORG_MEMBER);
      mock([member('me', 'me@x.com', 'MEMBER')]);
      render(withQuery(<OrgAdminPage params={params} />));
      await screen.findByRole('heading', { name: 'Acme' });
      expect(await screen.findByText('Active')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Deactivate organization' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Reactivate organization' })).toBeNull();
    });

    it('keeps the control from an organization admin who is no platform admin', async () => {
      mock([member('me', 'me@x.com', 'ADMIN')]);
      render(withQuery(<OrgAdminPage params={params} />));
      await screen.findByRole('heading', { name: 'Acme' });
      expect(screen.queryByRole('button', { name: 'Deactivate organization' })).toBeNull();
    });

    it('explains the consequences, and deactivates only on confirmation', async () => {
      setPermissions(ADMIN_PERMISSIONS);
      const spy = mock([member('me', 'me@x.com', 'ADMIN')]);
      render(withQuery(<OrgAdminPage params={params} />));
      fireEvent.click(await screen.findByRole('button', { name: 'Deactivate organization' }));

      const dialog = await screen.findByText('Deactivate this organization?');
      expect(dialog).toBeTruthy();
      expect(
        screen.getByText(/Every open request to join one of its teams is closed/)
      ).toBeTruthy();
      expect(screen.getByText(/disappear from the team directory/)).toBeTruthy();
      expect(urlOf(spy, 'PATCH')).toHaveLength(0);

      const before = urlOf(spy, 'GET').length;
      fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
      await waitFor(() =>
        expect(bodyOf(spy, `/api/v1/platform/organizations/${ORG_ID}`, 'PATCH')).toEqual({
          isActive: false,
        })
      );
      // The organization is read again, and so are the teams and the join-request lists.
      await waitFor(() => expect(urlOf(spy, 'GET').length).toBeGreaterThan(before));
    });

    it('shows an inactive organization as such, and reactivates it on confirmation', async () => {
      setPermissions(ADMIN_PERMISSIONS);
      const spy = mock([member('me', 'me@x.com', 'ADMIN')], { isActive: false });
      render(withQuery(<OrgAdminPage params={params} />));
      expect(await screen.findByText('Inactive')).toBeTruthy();
      expect(screen.getAllByText(/This organization is inactive\./).length).toBeGreaterThan(0);
      expect(screen.queryByRole('button', { name: 'Deactivate organization' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Reactivate organization' }));
      expect(await screen.findByText('Reactivate this organization?')).toBeTruthy();
      expect(screen.getByText(/are not reopened/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
      await waitFor(() =>
        expect(bodyOf(spy, `/api/v1/platform/organizations/${ORG_ID}`, 'PATCH')).toEqual({
          isActive: true,
        })
      );
    });

    it('answers the default organization refusal in words, and leaves the dialog open', async () => {
      setPermissions(ADMIN_PERMISSIONS);
      mock([member('me', 'me@x.com', 'ADMIN')], {
        patch: () =>
          gatewayError(
            409,
            'DEFAULT_ORGANIZATION',
            'The organization that owns the default team cannot be deactivated'
          ),
      });
      render(withQuery(<OrgAdminPage params={params} />));
      fireEvent.click(await screen.findByRole('button', { name: 'Deactivate organization' }));
      await screen.findByText('Deactivate this organization?');
      fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));

      expect(await screen.findByText(/This is the default organization/)).toBeTruthy();
      expect(
        screen.getByText(/Choose a different default team in Workflow defaults first/)
      ).toBeTruthy();
      expect(screen.getByText('Deactivate this organization?')).toBeTruthy();
    });

    it('shows any other refusal as the gateway worded it', async () => {
      setPermissions(ADMIN_PERMISSIONS);
      mock([member('me', 'me@x.com', 'ADMIN')], {
        patch: () => gatewayError(500, 'INTERNAL', 'Something broke'),
      });
      render(withQuery(<OrgAdminPage params={params} />));
      fireEvent.click(await screen.findByRole('button', { name: 'Deactivate organization' }));
      await screen.findByText('Deactivate this organization?');
      fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));

      expect(await screen.findByText('Something broke')).toBeTruthy();
    });
  });
});
