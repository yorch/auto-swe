// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '@/test/rtl-helpers';
import { useWorkflowRun } from './useRuns';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

function refetchIntervalOf(qc: QueryClient, fullTraces: boolean): unknown {
  const query = qc.getQueryCache().find({ queryKey: ['workflow-run', 'run-1', true, fullTraces] });
  const interval = query?.observers[0]?.options.refetchInterval;
  return typeof interval === 'function' ? interval(query as never) : interval;
}

describe('useWorkflowRun', () => {
  it('polls the trimmed view while the run is RUNNING', async () => {
    const fetchSpy = setupFetchMock({
      'GET /api/v1/workflow-runs/run-1': () => ({ data: { id: 'run-1', status: 'RUNNING' } }),
    });
    const { qc, wrapper } = setup();

    const { result } = renderHook(() => useWorkflowRun('run-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('?includeTraces=true');
    expect(refetchIntervalOf(qc, false)).toBe(3_000);
  });

  it('fetches full payloads once instead of polling them', async () => {
    const fetchSpy = setupFetchMock({
      'GET /api/v1/workflow-runs/run-1': () => ({ data: { id: 'run-1', status: 'RUNNING' } }),
    });
    const { qc, wrapper } = setup();

    const { result } = renderHook(() => useWorkflowRun('run-1', true, true), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('?fullTraces=true');
    expect(refetchIntervalOf(qc, true)).toBe(false);
  });

  it('keeps showing the same run while switching to full payloads', async () => {
    setupFetchMock({
      'GET /api/v1/workflow-runs/run-1': () => ({ data: { id: 'run-1', status: 'SUCCESS' } }),
    });
    const { wrapper } = setup();

    const { result, rerender } = renderHook(
      ({ full }: { full: boolean }) => useWorkflowRun('run-1', true, full),
      { initialProps: { full: false }, wrapper }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ full: true });

    // No blank frame: the trimmed data stands in until the full fetch lands.
    expect(result.current.data?.id).toBe('run-1');
  });
});
