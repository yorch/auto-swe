// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import OrgAdminPage from './page';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/organizations/11111111-1111-4111-8111-111111111111',
  useRouter: () => ({ push: vi.fn() }),
}));

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const params = Object.assign(Promise.resolve({ orgId: ORG_ID }), {
  status: 'fulfilled',
  value: { orgId: ORG_ID },
});

const member = (userId: string, email: string, role: string) => ({
  createdAt: '2026-01-01T00:00:00.000Z',
  id: `m-${userId}`,
  orgId: ORG_ID,
  role,
  user: { email, id: userId, name: null, role: 'ENGINEER' },
  userId,
});

beforeEach(() => {
  stubDialogPrototype();
  useAuthStore.setState({ isAuthenticated: true, user: { role: 'ADMIN', sub: 'me' } } as never);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mock(members: ReturnType<typeof member>[]) {
  return setupFetchMock({
    [`GET /api/v1/platform/organizations/${ORG_ID}`]: () => ({
      data: { id: ORG_ID, name: 'Acme', slug: 'acme', trustedInvites: false },
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
    [`PATCH /api/v1/platform/organizations/${ORG_ID}`]: () => ({ data: {} }),
    'GET /api/v1/users': () => ({ data: [] }),
    [`GET /api/v1/organizations/${ORG_ID}/github/installations`]: () => ({ data: [] }),
  });
}

describe('organization admin page', () => {
  it('offers GitHub connections to a platform engineer who is an organization admin', async () => {
    useAuthStore.setState({
      isAuthenticated: true,
      user: { role: 'ENGINEER', sub: 'me' },
    } as never);
    mock([member('me', 'me@x.com', 'ORG_ADMIN')]);
    render(withQuery(<OrgAdminPage params={params} />));
    expect(await screen.findByRole('button', { name: 'Connect a GitHub org' })).toBeTruthy();
    expect(await screen.findByText('No linked installations.')).toBeTruthy();
  });
  it('does not offer GitHub management to an ordinary organization member', async () => {
    useAuthStore.setState({
      isAuthenticated: true,
      user: { role: 'ENGINEER', sub: 'me' },
    } as never);
    mock([member('me', 'me@x.com', 'ORG_MEMBER')]);
    render(withQuery(<OrgAdminPage params={params} />));
    await screen.findByRole('heading', { name: 'Acme' });
    expect(screen.queryByRole('button', { name: 'Connect a GitHub org' })).toBeNull();
  });
  it('asks before trusting organization admin invites, and saves only on confirmation', async () => {
    const spy = mock([member('me', 'me@x.com', 'ORG_ADMIN')]);
    render(withQuery(<OrgAdminPage params={params} />));
    fireEvent.click(
      await screen.findByRole('switch', { name: 'Trust organization admin invites' })
    );
    expect(await screen.findByText('Trust organization admin invites?')).toBeTruthy();
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

  it('will not offer to demote the only organization admin', async () => {
    mock([member('u2', 'only@x.com', 'ORG_ADMIN'), member('u3', 'plain@x.com', 'ORG_MEMBER')]);
    render(withQuery(<OrgAdminPage params={params} />));
    const select = await screen.findByRole('button', { name: /Org role for only@x.com/ });
    expect((select as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('The only organization admin')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Org role for plain@x.com/ }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });

  it('shows an ORG_MEMBER the percentage meter and never asks for the dollar budget', async () => {
    useAuthStore.setState({
      isAuthenticated: true,
      user: { role: 'ENGINEER', sub: 'me' },
    } as never);
    const spy = mock([
      member('me', 'me@x.com', 'ORG_MEMBER'),
      member('u2', 'a@x.com', 'ORG_ADMIN'),
    ]);
    render(withQuery(<OrgAdminPage params={params} />));
    expect(await screen.findByTestId('budget-meter')).toBeTruthy();
    expect(screen.getByText('41% of the org budget this month')).toBeTruthy();
    const urls = spy.mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => u.endsWith('/budget'))).toBe(false);
    expect(screen.queryByText('Save budget')).toBeNull();
  });

  it('keeps Save budget disabled until a value changes', async () => {
    mock([member('me', 'me@x.com', 'ORG_ADMIN')]);
    render(withQuery(<OrgAdminPage params={params} />));
    const save = (await screen.findByRole('button', { name: 'Save budget' })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Monthly cap'), { target: { value: '50' } });
    expect(save.disabled).toBe(false);
  });
});
