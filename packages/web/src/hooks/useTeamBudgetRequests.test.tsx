// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock } from '@/test/rtl-helpers';
import { useCreateTeamBudgetRequest, useTeamBudgetRequests } from './useTeamBudgetRequests';

afterEach(() => vi.unstubAllGlobals());

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('team budget request hooks', () => {
  it('lists the pending requests only when enabled', async () => {
    const spy = setupFetchMock({
      'GET /api/v1/teams/t-1/budget-requests': () => ({ data: [{ id: 'b1', reason: 'More' }] }),
    });
    const off = renderHook(() => useTeamBudgetRequests('t-1', false), {
      wrapper: wrapper(newClient()),
    });
    expect(off.result.current.fetchStatus).toBe('idle');
    expect(spy).not.toHaveBeenCalled();
    const on = renderHook(() => useTeamBudgetRequests('t-1', true), {
      wrapper: wrapper(newClient()),
    });
    await waitFor(() => expect(on.result.current.isSuccess).toBe(true));
    expect(on.result.current.data?.[0]?.id).toBe('b1');
  });

  it('POSTs the reason', async () => {
    const spy = setupFetchMock({
      'POST /api/v1/teams/t-1/budget-requests': () => ({ data: { id: 'b1' } }),
    });
    const { result } = renderHook(() => useCreateTeamBudgetRequest('t-1'), {
      wrapper: wrapper(newClient()),
    });
    await act(async () => {
      await result.current.mutateAsync({ reason: 'Launch month' });
    });
    expect(bodyOf(spy, '/api/v1/teams/t-1/budget-requests')).toEqual({ reason: 'Launch month' });
  });

  it('refreshes the pending requests after one is created', async () => {
    const qc = newClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    setupFetchMock({
      'POST /api/v1/teams/t-1/budget-requests': () => ({ data: { id: 'b1' } }),
    });
    const { result } = renderHook(() => useCreateTeamBudgetRequest('t-1'), {
      wrapper: wrapper(qc),
    });
    await act(async () => {
      await result.current.mutateAsync({ reason: 'Launch month' });
    });
    expect(invalidate.mock.calls.map(([f]) => f?.queryKey)).toContainEqual([
      'team-budget-requests',
      't-1',
    ]);
  });
});
