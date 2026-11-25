// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { setupFetchMock } from '@/test/rtl-helpers';
import { splitTeamsByStanding, useTeamNav } from './useTeamNav';

beforeEach(() =>
  useAuthStore.setState({ isAuthenticated: true, user: { role: 'USER', sub: 'me' } })
);
afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ isAuthenticated: false, user: null });
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const team = (slug: string, name: string, myRole: string | null) => ({
  id: `id-${slug}`,
  myRole,
  name,
  orgId: 'o',
  orgName: 'Acme',
  slug,
});

describe('useTeamNav', () => {
  it('lists only teams the caller is a member of, with the desk’s needs-you counts', async () => {
    setupFetchMock({
      '/api/v1/me/summary': () => ({
        needsYou: { items: [], total: 2 },
        teams: [{ needsYou: 2, queued: 0, running: 1, teamId: 'id-pay' }],
      }),
      // A platform ADMIN's list can carry a team they are not in (myRole null).
      '/api/v1/teams': () => ({
        data: [
          team('zeta', 'Zeta', null),
          team('pay', 'Payments', 'LEAD'),
          team('a', 'Alpha', 'ENGINEER'),
        ],
      }),
    });
    const { result } = renderHook(() => useTeamNav(), { wrapper });
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    expect(result.current.entries.map((e) => e.team.name)).toEqual(['Alpha', 'Payments']);
    await waitFor(() => expect(result.current.entries[1]?.needsYou).toBe(2));
    expect(result.current.entries[0]?.needsYou).toBe(0);
  });

  const permissions = (platformCapabilities: string[]) => ({
    organizations: [],
    platformCapabilities,
    platformRole: '',
    teams: [],
  });

  it('collects the visible teams the caller is not a member of as administered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.includes('/me/permissions')
          ? permissions([])
          : url.includes('/me/summary')
            ? { needsYou: { items: [], total: 0 }, teams: [] }
            : {
                data: [team('pay', 'Payments', 'LEAD'), team('ops', 'Ops', null)],
              };
        return new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        });
      })
    );
    const { result } = renderHook(() => useTeamNav(), { wrapper });
    await waitFor(() => expect(result.current.administered).toHaveLength(1));
    expect(result.current.administered[0]?.slug).toBe('ops');
    expect(result.current.entries.map((e) => e.team.slug)).toEqual(['pay']);
  });

  it('adds no administered group for a platform admin', async () => {
    const spy = setupFetchMock({
      '/api/v1/me/permissions': () => permissions(['platform.users.manage']),
      '/api/v1/me/summary': () => ({ needsYou: { items: [], total: 0 }, teams: [] }),
      '/api/v1/teams': () => ({
        data: [team('pay', 'Payments', 'LEAD'), team('ops', 'Ops', null)],
      }),
    });
    const { result } = renderHook(() => useTeamNav(), { wrapper });
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    await waitFor(() =>
      expect(spy.mock.calls.some(([u]) => String(u).includes('/me/permissions'))).toBe(true)
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.administered).toEqual([]);
  });
});

describe('splitTeamsByStanding', () => {
  it('separates teams the caller is on from the ones reached by authority, by name', () => {
    const { administered, member } = splitTeamsByStanding([
      team('z', 'Zeta', null),
      team('b', 'Beta', 'MEMBER'),
      team('a', 'Alpha', null),
    ] as never);
    expect(member.map((t) => t.name)).toEqual(['Beta']);
    expect(administered.map((t) => t.name)).toEqual(['Alpha', 'Zeta']);
  });
});
