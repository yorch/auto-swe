// @vitest-environment jsdom
import type { TeamSummary } from '@auto-swe/shared/types/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { TeamSetupChecklist } from './TeamSetupChecklist';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const team: TeamSummary = {
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

describe('team setup checklist', () => {
  it('refreshes recent cached setup when returning from settings or connections', async () => {
    useAuthStore.setState({ user: { role: 'LEAD', sub: 'me' } });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(['team', 't1'], {
      memberships: [{}],
      monthlyBudgetUsdCents: null,
      repositories: [],
      sharedRepositories: [],
    });
    setupFetchMock({
      '/api/v1/teams/t1': () => ({
        data: {
          memberships: [{}, {}],
          monthlyBudgetUsdCents: 10000,
          repositories: [{ isActive: true }],
          sharedRepositories: [],
        },
      }),
    });
    render(
      <QueryClientProvider client={client}>
        <TeamSetupChecklist team={team} />
      </QueryClientProvider>
    );
    await waitFor(() => expect(screen.queryByText('Team setup')).toBeNull());
    expect(client.getQueryData(['team', 't1'])).toMatchObject({ monthlyBudgetUsdCents: 10000 });
  });

  it('shows missing setup to a team lead and links to the working surfaces', async () => {
    useAuthStore.setState({ user: { role: 'LEAD', sub: 'me' } });
    setupFetchMock({
      '/api/v1/teams/t1': () => ({
        data: {
          memberships: [{}],
          monthlyBudgetUsdCents: null,
          repositories: [],
          sharedRepositories: [],
        },
      }),
    });
    render(withQuery(<TeamSetupChecklist team={team} />));
    expect(await screen.findByText('Team setup')).toBeTruthy();
    expect(screen.getAllByLabelText('Incomplete')).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'Set a team budget' }).getAttribute('href')).toBe(
      '/teams/payments/settings?tab=budget'
    );
    expect(screen.getByRole('link', { name: /repository/ }).getAttribute('href')).toBe(
      '/connections?team=payments'
    );
  });

  it('counts shared repositories and hides once every item is complete', async () => {
    useAuthStore.setState({ user: { role: 'ADMIN', sub: 'me' } });
    const spy = setupFetchMock({
      '/api/v1/teams/t1': () => ({
        data: {
          memberships: [{}, {}],
          monthlyBudgetUsdCents: 0,
          repositories: [],
          sharedRepositories: [{ id: 'r1' }],
        },
      }),
    });
    const { container } = render(
      withQuery(<TeamSetupChecklist team={{ ...team, myRole: null }} />)
    );
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    await vi.waitFor(() => expect(container.textContent).toBe(''));
  });

  it('never loads setup for a team engineer', () => {
    useAuthStore.setState({ user: { role: 'ENGINEER', sub: 'me' } });
    const spy = setupFetchMock({});
    render(withQuery(<TeamSetupChecklist team={{ ...team, myRole: 'ENGINEER' }} />));
    expect(screen.queryByText('Team setup')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('shows a retryable error instead of inventing missing setup', async () => {
    useAuthStore.setState({ user: { role: 'LEAD', sub: 'me' } });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(withQuery(<TeamSetupChecklist team={team} />));
    expect(await screen.findByRole('button', { name: /retry/i })).toBeTruthy();
    expect(screen.queryByText('Team setup')).toBeNull();
  });
});
