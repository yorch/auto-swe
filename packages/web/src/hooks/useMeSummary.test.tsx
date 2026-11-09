// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '@/test/rtl-helpers';
import { ME_SUMMARY_KEY, useMeSummary } from './useMeSummary';

afterEach(() => vi.unstubAllGlobals());

const SUMMARY = { needsYou: { items: [], total: 0 }, teams: [] };

function setup(handler: () => unknown) {
  const fetchSpy = setupFetchMock({ '/api/v1/me/summary': handler });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { fetchSpy, qc, ...renderHook(() => useMeSummary(), { wrapper }) };
}

describe('useMeSummary', () => {
  it('loads the summary from /api/v1/me/summary', async () => {
    const { result, fetchSpy } = setup(() => SUMMARY);
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(SUMMARY);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/v1/me/summary');
  });

  it('surfaces an error', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useMeSummary(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('polls, and the approvals stream prefix does not refetch it', async () => {
    expect(ME_SUMMARY_KEY[0]).toBe('me-summary');
    const { result, qc, fetchSpy } = setup(() => SUMMARY);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const interval = qc.getQueryCache().getAll()[0]?.observers[0]?.options.refetchInterval;
    expect(interval).toBeGreaterThanOrEqual(10_000);
    expect(interval).toBeLessThanOrEqual(30_000);
    await qc.invalidateQueries({ queryKey: ['approvals'] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await qc.invalidateQueries({ queryKey: ME_SUMMARY_KEY });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
  });
});
