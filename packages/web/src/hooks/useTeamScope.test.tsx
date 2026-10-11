// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTeamStore } from '@/stores/teamStore';
import { setupFetchMock } from '@/test/rtl-helpers';
import { useRequests } from './useRequests';
import { usePullRequests } from './useWorkViews';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const page = { data: [], meta: { limit: 1, offset: 0, total: 0 } };
const PR = { draft: 'any', limit: 1, offset: 0, scope: 'MINE', state: 'MERGED' } as const;

beforeEach(() => useTeamStore.setState({ selectedTeamId: 'team-1' }));
afterEach(() => {
  vi.unstubAllGlobals();
  useTeamStore.setState({ selectedTeamId: null });
});

function urls(spy: ReturnType<typeof vi.fn>) {
  return spy.mock.calls.map(([input]) => String(input));
}

describe('useRequests team scope', () => {
  it('adds the selected team by default', async () => {
    const spy = setupFetchMock({ '/api/v1/workflow-runs/requests': () => page });
    const { result } = renderHook(() => useRequests({ limit: 1, scope: 'MINE' }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(urls(spy)[0]).toContain('teamId=team-1');
  });

  it('leaves the selected team out when asked to ignore it', async () => {
    const spy = setupFetchMock({ '/api/v1/workflow-runs/requests': () => page });
    const { result } = renderHook(
      () => useRequests({ limit: 1, scope: 'MINE' }, { ignoreTeam: true }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(urls(spy)[0]).not.toContain('teamId');
    expect(urls(spy)[0]).toContain('scope=MINE');
  });
});

describe('usePullRequests team scope', () => {
  it('adds the selected team by default', async () => {
    const spy = setupFetchMock({ '/api/v1/pull-requests': () => page });
    const { result } = renderHook(() => usePullRequests(PR), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(urls(spy)[0]).toContain('teamId=team-1');
  });

  it('leaves the selected team out when asked to ignore it', async () => {
    const spy = setupFetchMock({ '/api/v1/pull-requests': () => page });
    const { result } = renderHook(() => usePullRequests(PR, { ignoreTeam: true }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(urls(spy)[0]).not.toContain('teamId');
    expect(urls(spy)[0]).toContain('state=MERGED');
  });
});
