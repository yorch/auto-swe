// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '@/test/rtl-helpers';
import { useApprovals, useApprovalsCount, useRespondToApproval } from './useApprovals';
import { ME_SUMMARY_KEY } from './useMeSummary';

afterEach(() => vi.unstubAllGlobals());

function pollInterval(args: Parameters<typeof useApprovals>) {
  setupFetchMock({ '/api/v1/human-steps': () => ({ data: [] }) });
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useApprovals(...args), { wrapper });
  return waitFor(() => expect(result.current.isSuccess).toBe(true)).then(
    () => qc.getQueryCache().getAll()[0]?.observers[0]?.options.refetchInterval
  );
}

describe('useApprovals fallback poll', () => {
  it('polls pending steps', async () => {
    expect(await pollInterval(['PENDING'])).toBe(30_000);
  });

  it("polls one run's steps even when the status filter is ALL", async () => {
    expect(await pollInterval(['ALL', 'requestedAt:desc', false, 'run-1'])).toBe(30_000);
  });

  it('does not poll the unscoped history', async () => {
    expect(await pollInterval(['ALL'])).toBe(false);
  });
});

describe('useApprovalsCount', () => {
  function renderCount(handler: () => unknown) {
    const fetchSpy = setupFetchMock({ '/api/v1/human-steps': handler });
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useApprovalsCount(), { wrapper });
    return { fetchSpy, qc, result };
  }

  it('returns meta.total rather than the length of the (capped) list', async () => {
    const { result, fetchSpy } = renderCount(() => ({
      data: [{ id: 'a' }],
      meta: { total: 250 },
    }));
    await waitFor(() => expect(result.current).toBe(250));
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain('/api/v1/human-steps?');
    expect(url).toContain('actionable=true');
    expect(url).toContain('limit=1');
    expect(url).toContain('count=true');
  });

  it('falls back to 0 when meta.total is missing', async () => {
    const { result } = renderCount(() => ({ data: [{ id: 'a' }] }));
    await waitFor(() => expect(result.current).toBe(0));
  });

  it('polls on the 30 s fallback interval', async () => {
    const { result, qc } = renderCount(() => ({ data: [], meta: { total: 0 } }));
    await waitFor(() => expect(result.current).toBe(0));
    const observer = qc.getQueryCache().getAll()[0]?.observers[0];
    expect(observer?.options.refetchInterval).toBe(30_000);
  });
});

describe('useRespondToApproval', () => {
  it('refreshes the desk, which the approvals stream no longer does', async () => {
    setupFetchMock({ '/api/v1/human-steps/s1/respond': () => ({}) });
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useRespondToApproval(), { wrapper });
    result.current.mutate({ action: 'approve', id: 's1' });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ME_SUMMARY_KEY }));
  });
});
