// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '@/test/rtl-helpers';
import { useTeamNav } from './useTeamNav';

afterEach(() => vi.unstubAllGlobals());

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
});
