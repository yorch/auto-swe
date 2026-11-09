// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '@/test/rtl-helpers';
import { useEpics } from './useEpics';
import { useRequests } from './useRequests';
import { usePullRequests, useTickets } from './useWorkViews';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const page = { data: [], meta: { limit: 1, offset: 0, total: 0 } };
const PR = { draft: 'any', limit: 1, offset: 0, scope: 'MINE', state: 'MERGED' } as const;

afterEach(() => vi.unstubAllGlobals());

function urls(spy: ReturnType<typeof vi.fn>) {
  return spy.mock.calls.map(([input]) => String(input));
}

describe('the team a list is narrowed to is an option, never ambient state', () => {
  it('useRequests sends the teamId it is given', async () => {
    const spy = setupFetchMock({ '/api/v1/workflow-runs/requests': () => page });
    const { result } = renderHook(
      () => useRequests({ limit: 1, scope: 'MINE' }, { teamId: 'team-1' }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(urls(spy)[0]).toContain('teamId=team-1');
  });

  it('useRequests lists every team without one', async () => {
    const spy = setupFetchMock({ '/api/v1/workflow-runs/requests': () => page });
    const { result } = renderHook(() => useRequests({ limit: 1, scope: 'MINE' }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(urls(spy)[0]).not.toContain('teamId');
    expect(urls(spy)[0]).toContain('scope=MINE');
  });

  it('useRequests does not fetch while disabled, so a pending ?team= never flashes all teams', () => {
    const spy = setupFetchMock({ '/api/v1/workflow-runs/requests': () => page });
    renderHook(() => useRequests({ limit: 1, scope: 'MINE' }, { enabled: false }), { wrapper });
    expect(spy).not.toHaveBeenCalled();
  });

  it('usePullRequests sends the teamId and keeps its other filters', async () => {
    const spy = setupFetchMock({ '/api/v1/pull-requests': () => page });
    const { result } = renderHook(() => usePullRequests(PR, { teamId: 'team-1' }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(urls(spy)[0]).toContain('teamId=team-1');
    expect(urls(spy)[0]).toContain('state=MERGED');
  });

  it('usePullRequests lists every team without one', async () => {
    const spy = setupFetchMock({ '/api/v1/pull-requests': () => page });
    const { result } = renderHook(() => usePullRequests(PR), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(urls(spy)[0]).not.toContain('teamId');
  });

  it('useTickets and useEpics send the teamId they are given', async () => {
    const spy = setupFetchMock({
      '/api/v1/epics': () => page,
      '/api/v1/tickets': () => page,
    });
    const tickets = renderHook(
      () =>
        useTickets(
          { includeAutomated: false, limit: 1, offset: 0, scope: 'TEAM' },
          { teamId: 'team-2' }
        ),
      { wrapper }
    );
    const epics = renderHook(() => useEpics({ scope: 'TEAM' }, { teamId: 'team-2' }), {
      wrapper,
    });
    await waitFor(() => expect(tickets.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(epics.result.current.isSuccess).toBe(true));
    expect(urls(spy).every((u) => u.includes('teamId=team-2'))).toBe(true);
    expect(urls(spy)).toHaveLength(2);
  });
});
