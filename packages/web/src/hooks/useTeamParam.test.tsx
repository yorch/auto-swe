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

  it('resolves the slug through the caller’s member teams only', async () => {
    resetNavigation('team=payments', '/requests');
    const spy = setupFetchMock({ '/api/v1/teams': () => MEMBER_TEAMS });
    const { result } = renderHook(() => useTeamParam(), { wrapper });
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(result.current.team?.name).toBe('Payments'));
    expect(result.current.teamId).toBe('team-1');
    expect(result.current.pending).toBe(false);
    expect(String(spy.mock.calls[0]?.[0])).toContain('member=true');
  });

  it('ignores a slug that names no member team, without an error', async () => {
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

  it('lets a platform ADMIN open a team they are not a member of, and only an ADMIN', async () => {
    resetNavigation('team=elsewhere', '/requests');
    const all = {
      data: [{ id: 'team-9', myRole: null, name: 'Elsewhere', slug: 'elsewhere' }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        json(String(input).includes('member=true') ? MEMBER_TEAMS : all)
      )
    );
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'ADMIN', sub: 'a' } });
    const admin = renderHook(() => useTeamParam(), { wrapper });
    await waitFor(() => expect(admin.result.current.teamId).toBe('team-9'));
    admin.unmount();

    useAuthStore.setState({ isAuthenticated: true, user: { role: 'LEAD', sub: 'l' } });
    const lead = renderHook(() => useTeamParam(), { wrapper });
    await waitFor(() => expect(lead.result.current.pending).toBe(false));
    expect(lead.result.current.team).toBeNull();
    expect(lead.result.current.isError).toBe(false);
  });
});
