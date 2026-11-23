// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { nav, resetNavigation } from '@/test/mockNavigation';
import { setupFetchMock } from '@/test/rtl-helpers';
import { useTeamParam } from './useTeamParam';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const MEMBER_TEAMS = {
  data: [{ id: 'team-1', myRole: 'LEAD', name: 'Payments', slug: 'payments' }],
};

beforeEach(() => resetNavigation('', '/requests'));
afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ isAuthenticated: false, user: null });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });

describe('useTeamParam', () => {
  it('does nothing and asks for nothing without ?team=', () => {
    const spy = setupFetchMock({ '/api/v1/teams': () => MEMBER_TEAMS });
    const { result } = renderHook(() => useTeamParam(), { wrapper });
    expect(result.current).toMatchObject({ pending: false, slug: '', team: null });
    expect(result.current.teamId).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('resolves the slug through the caller’s member teams first', async () => {
    resetNavigation('team=payments', '/requests');
    const spy = setupFetchMock({ '/api/v1/teams': () => MEMBER_TEAMS });
    const { result } = renderHook(() => useTeamParam(), { wrapper });
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(result.current.team?.name).toBe('Payments'));
    expect(result.current.teamId).toBe('team-1');
    expect(result.current.pending).toBe(false);
    expect(String(spy.mock.calls[0]?.[0])).toContain('member=true');
  });

  it('resolves a team the caller administers without belonging to', async () => {
    resetNavigation('team=ops', '/requests');
    // The member list lacks it; only the full visible list names it (myRole null).
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        json(
          String(input).includes('member=true')
            ? MEMBER_TEAMS
            : {
                data: [
                  ...MEMBER_TEAMS.data,
                  { id: 'team-2', myRole: null, name: 'Ops', slug: 'ops' },
                ],
              }
        )
      )
    );
    const { result } = renderHook(() => useTeamParam(), { wrapper });
    await waitFor(() => expect(result.current.team?.name).toBe('Ops'));
    expect(result.current.teamId).toBe('team-2');
    expect(result.current.blocked).toBe(false);
  });

  it('ignores a slug that names no visible team, without an error', async () => {
    resetNavigation('team=secret-team', '/requests');
    setupFetchMock({ '/api/v1/teams': () => MEMBER_TEAMS });
    const { result } = renderHook(() => useTeamParam(), { wrapper });
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.team).toBeNull();
    expect(result.current.teamId).toBeUndefined();
  });

  it('clear drops the team and the page offset but keeps the other filters', async () => {
    resetNavigation('team=payments&state=failed&offset=30', '/requests');
    setupFetchMock({ '/api/v1/teams': () => MEMBER_TEAMS });
    const { result } = renderHook(() => useTeamParam(), { wrapper });
    await waitFor(() => expect(result.current.team).not.toBeNull());
    act(() => result.current.clear());
    expect(nav.replace.at(-1)).toBe('/requests?state=failed');
  });

  it('reports an error, not an unknown slug, when the team list fails', async () => {
    resetNavigation('team=payments', '/requests');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { code: 'INTERNAL', message: 'boom' } }, 500))
    );
    const { result } = renderHook(() => useTeamParam(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.pending).toBe(false);
    // A list hook stays disabled on `blocked`, so it cannot show every team's rows meanwhile.
    expect(result.current.blocked).toBe(true);
    expect(result.current.teamId).toBeUndefined();
  });

  it('resolves a team the caller is not a member of when the server lists it, for a platform ADMIN or not', async () => {
    resetNavigation('team=elsewhere', '/requests');
    const all = {
      data: [{ id: 'team-9', myRole: null, name: 'Elsewhere', slug: 'elsewhere' }],
    };
    // The server describes the signed-in person: 'a' holds every platform capability, 'l' none.
    let who = 'a';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/me/permissions')) {
          return json({
            organizations: [],
            platformCapabilities: who === 'a' ? ['platform.users.manage'] : [],
            platformRole: '',
            teams: [],
          });
        }
        return json(url.includes('member=true') ? MEMBER_TEAMS : all);
      })
    );
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'USER', sub: 'a' } });
    const admin = renderHook(() => useTeamParam(), { wrapper });
    await waitFor(() => expect(admin.result.current.teamId).toBe('team-9'));
    admin.unmount();

    // Visibility is the server's answer, not the platform role: a person whose list carries the
    // team (an organization admin) resolves it too, and one whose list lacks it gets nothing.
    who = 'l';
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'USER', sub: 'l' } });
    const orgAdmin = renderHook(() => useTeamParam(), { wrapper });
    await waitFor(() => expect(orgAdmin.result.current.teamId).toBe('team-9'));
    orgAdmin.unmount();

    resetNavigation('team=hidden', '/requests');
    const stranger = renderHook(() => useTeamParam(), { wrapper });
    await waitFor(() => expect(stranger.result.current.pending).toBe(false));
    expect(stranger.result.current.team).toBeNull();
    expect(stranger.result.current.isError).toBe(false);
  });
});
