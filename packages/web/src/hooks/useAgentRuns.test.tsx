// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '@/test/rtl-helpers';
import { useAgentRunAgents, useAgentRunLimits, useRerunAgentRun } from './useAgentRuns';

afterEach(() => vi.unstubAllGlobals());

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useRerunAgentRun', () => {
  it('posts to the agent-run re-run endpoint, never the generic work-request retry', async () => {
    const fetchSpy = setupFetchMock({
      'POST /api/v1/agent-runs/wr-1/rerun': () => ({
        data: { temporalWorkflowId: 'agent-2', workRequestId: 'wr-2' },
      }),
    });
    const { result } = renderHook(() => useRerunAgentRun(), { wrapper: wrapper() });
    await act(async () => {
      await result.current.mutateAsync('wr-1');
    });
    await waitFor(() => expect(result.current.data?.workRequestId).toBe('wr-2'));
    const urls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes('/work-requests/'))).toBe(false);
  });
});

describe('form-support reads', () => {
  it('scope the agent list and the limits to the chosen repository', async () => {
    const fetchSpy = setupFetchMock({
      '/api/v1/agent-runs/agents': () => ({ data: [] }),
      '/api/v1/agent-runs/limits': () => ({ data: { enabled: true } }),
    });
    const w = wrapper();
    renderHook(() => useAgentRunAgents('repo 1'), { wrapper: w });
    renderHook(() => useAgentRunLimits(null), { wrapper: w });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const urls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.endsWith('/api/v1/agent-runs/agents?repoId=repo%201'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/api/v1/agent-runs/limits'))).toBe(true);
  });
});
