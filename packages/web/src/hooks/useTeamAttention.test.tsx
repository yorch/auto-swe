// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock } from '@/test/rtl-helpers';
import {
  useAssignFailure,
  useNudgeHumanStep,
  useTeamAttentionFailures,
  useTeamStaleApprovals,
} from './useTeamAttention';

afterEach(() => vi.unstubAllGlobals());

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('team attention hooks', () => {
  it('lists the unowned failures of the team', async () => {
    setupFetchMock({
      'GET /api/v1/teams/t-1/attention/failures': () => ({
        data: [{ runId: 'r1', title: 'Fix it' }],
      }),
    });
    const { result } = renderHook(() => useTeamAttentionFailures('t-1'), {
      wrapper: wrapper(newClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.runId).toBe('r1');
  });

  it('asks for the overdue pending steps of the team', async () => {
    const spy = setupFetchMock({ 'GET /api/v1/human-steps': () => ({ data: [] }) });
    const { result } = renderHook(() => useTeamStaleApprovals('t-1'), {
      wrapper: wrapper(newClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain('overdue=true');
    expect(url).toContain('teamId=t-1');
  });

  it('POSTs the assignment and refreshes the attention list, the overview and the desk', async () => {
    const qc = newClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const spy = setupFetchMock({
      'POST /api/v1/teams/t-1/failure-assignments': () => ({ data: {} }),
    });
    const { result } = renderHook(() => useAssignFailure('t-1'), { wrapper: wrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ assigneeId: 'u1', runId: 'r1' });
    });
    expect(bodyOf(spy, '/api/v1/teams/t-1/failure-assignments')).toEqual({
      assigneeId: 'u1',
      runId: 'r1',
    });
    const keys = invalidate.mock.calls.map(([f]) => f?.queryKey);
    expect(keys).toContainEqual(['team-attention-failures', 't-1']);
    expect(keys).toContainEqual(['team-overview', 't-1']);
    expect(keys).toContainEqual(['me-summary']);
  });

  it('POSTs a nudge to the step and returns when it went out', async () => {
    const spy = setupFetchMock({
      'POST /api/v1/human-steps/s1/nudge': () => ({ data: { nudgedAt: '2026-11-16T10:00:00Z' } }),
    });
    const { result } = renderHook(() => useNudgeHumanStep(), { wrapper: wrapper(newClient()) });
    let nudged: { nudgedAt: string } | undefined;
    await act(async () => {
      nudged = await result.current.mutateAsync('s1');
    });
    expect(nudged?.nudgedAt).toBe('2026-11-16T10:00:00Z');
    expect(spy).toHaveBeenCalled();
  });
});
