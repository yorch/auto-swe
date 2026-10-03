// @vitest-environment jsdom

import type { AgentTraceRecord } from '@auto-swe/shared/types/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '@/test/rtl-helpers';
import {
  mergeTraces,
  RETRIED_RUN_WAIT_MS,
  TRACE_TAIL_OVERLAP_MS,
  traceTailCursor,
  useRetriedRun,
  useRunDetail,
  useWorkflowRun,
} from './useRuns';

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

function trace(id: string, createdAt: string, seq = 0): AgentTraceRecord {
  return { createdAt, id, seq, trimmed: false } as AgentTraceRecord;
}

describe('trace live tail', () => {
  it('sets the cursor a fixed overlap behind the newest trace', () => {
    expect(traceTailCursor([])).toBeNull();
    const cursor = traceTailCursor([
      trace('a', '2026-09-01T10:00:30.000Z'),
      trace('b', '2026-09-01T10:00:00.000Z'),
    ]);
    expect(Date.parse('2026-09-01T10:00:30.000Z') - Date.parse(cursor as string)).toBe(
      TRACE_TAIL_OVERLAP_MS
    );
  });

  it('appends only unseen traces, in createdAt then seq order', () => {
    const held = [
      trace('a', '2026-09-01T10:00:00.000Z', 0),
      trace('b', '2026-09-01T10:00:05.000Z'),
    ];
    const merged = mergeTraces(held, [
      trace('b', '2026-09-01T10:00:05.000Z'),
      // Committed late: older than a trace already held.
      trace('late', '2026-09-01T10:00:00.000Z', 1),
      trace('c', '2026-09-01T10:00:06.000Z'),
    ]);
    expect(merged.map((t) => t.id)).toEqual(['a', 'late', 'b', 'c']);
  });

  it('keeps the held array when nothing is new, so the page does not re-render', () => {
    const held = [trace('a', '2026-09-01T10:00:00.000Z')];
    expect(mergeTraces(held, [trace('a', '2026-09-01T10:00:00.000Z')])).toBe(held);
  });

  it('after the first load, polls the trace-free run and only new traces, then appends them', async () => {
    const fetchSpy = setupFetchMock({
      'GET /api/v1/workflow-runs/run-1': () => ({
        data: {
          id: 'run-1',
          status: 'RUNNING',
          steps: [],
          traces: fetchSpy.mock.calls.length === 1 ? [trace('t1', '2026-09-01T10:00:00.000Z')] : [],
        },
      }),
      'GET /api/v1/workflow-runs/run-1/traces': () => ({
        data: [trace('t1', '2026-09-01T10:00:00.000Z'), trace('t2', '2026-09-01T10:00:04.000Z')],
      }),
    });
    const { wrapper } = setup();
    const { result } = renderHook(() => useWorkflowRun('run-1'), { wrapper });
    await waitFor(() => expect(result.current.data?.traces).toHaveLength(1));

    await act(() => result.current.refetch());

    const urls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(urls[0]).toContain('/api/v1/workflow-runs/run-1?includeTraces=true');
    // The poll: the run without traces, and the tail from the cursor.
    expect(urls.slice(1)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/api\/v1\/workflow-runs\/run-1$/),
        expect.stringContaining(
          `/api/v1/workflow-runs/run-1/traces?since=${encodeURIComponent('2026-09-01T09:59:50.000Z')}`
        ),
      ])
    );
    await waitFor(() => expect(result.current.data?.traces.map((t) => t.id)).toEqual(['t1', 't2']));
  });

  it('never tails the full-payload view', async () => {
    const fetchSpy = setupFetchMock({
      'GET /api/v1/workflow-runs/run-1': () => ({
        data: { id: 'run-1', status: 'RUNNING', traces: [trace('t1', '2026-09-01T10:00:00.000Z')] },
      }),
    });
    const { wrapper } = setup();
    const { result } = renderHook(() => useWorkflowRun('run-1', true, true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await act(() => result.current.refetch());

    const urls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(urls).toHaveLength(2);
    expect(urls.every((u) => u.endsWith('?fullTraces=true'))).toBe(true);
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

describe('useRunDetail', () => {
  /** Every committed render's view of the query — what the page would paint. */
  function record() {
    const committed: Array<{ fullTraces: boolean; isError: boolean; hasRun: boolean }> = [];
    const { wrapper } = setup();
    const hook = renderHook(
      () => {
        const d = useRunDetail('run-1');
        useEffect(() => {
          committed.push({ fullTraces: d.fullTraces, hasRun: !!d.data, isError: d.isError });
        });
        return d;
      },
      { wrapper }
    );
    return { committed, ...hook };
  }

  const failFullPayloads = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('fullTraces=true')
          ? json({ error: { message: 'too big' } }, 500)
          : String(input).includes('/traces')
            ? json({ data: [] })
            : json({ data: { id: 'run-1', status: 'RUNNING' } })
      )
    );

  it('never commits an error state when only the full-payload fetch fails', async () => {
    failFullPayloads();
    const { committed, result } = record();
    await waitFor(() => expect(result.current.data?.id).toBe('run-1'));

    act(() => result.current.toggleFullTraces());
    await waitFor(() => expect(result.current.fullTracesFailed).toBe(true));

    // Back on the trimmed view, with its run still there and no error shown.
    expect(result.current.fullTraces).toBe(false);
    expect(result.current.isError).toBe(false);
    expect(result.current.data?.id).toBe('run-1');
    expect(committed.some((c) => c.isError)).toBe(false);
  });

  it('still reports an error when the trimmed load fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { message: 'boom' } }, 500))
    );
    const { result } = record();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.fullTraces).toBe(false);
    expect(result.current.fullTracesFailed).toBe(false);
  });

  it('clears the failure note when the toggle is used again', async () => {
    failFullPayloads();
    const { result } = record();
    await waitFor(() => expect(result.current.data?.id).toBe('run-1'));
    act(() => result.current.toggleFullTraces());
    await waitFor(() => expect(result.current.fullTracesFailed).toBe(true));

    act(() => result.current.toggleFullTraces());

    expect(result.current.fullTracesFailed).toBe(false);
  });
});

describe('useRetriedRun', () => {
  const runs = (workflowIds: string[]) => ({
    data: workflowIds.map((workflowId) => ({ id: `run-of-${workflowId}`, workflowId })),
  });

  it('resolves the run whose workflow id matches, ignoring the earlier run', async () => {
    const fetchSpy = setupFetchMock({
      'GET /api/v1/workflow-runs': () => runs(['wf-new', 'wf-old']),
    });
    const { wrapper } = setup();

    const { result } = renderHook(() => useRetriedRun('wr-1', 'wf-new'), { wrapper });

    await waitFor(() => expect(result.current.runId).toBe('run-of-wf-new'));
    expect(result.current.timedOut).toBe(false);
    // Scoped to the work request, so another request's runs can't match.
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('workRequestId=wr-1');
  });

  it('does not resolve to a run with a different workflow id', async () => {
    setupFetchMock({ 'GET /api/v1/workflow-runs': () => runs(['wf-old', 'wf-other']) });
    const { wrapper } = setup();

    const { result } = renderHook(() => useRetriedRun('wr-1', 'wf-new'), { wrapper });

    await waitFor(() => expect(result.current.runId).toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.runId).toBeNull();
  });

  it('keeps polling until the worker has created the run', async () => {
    let calls = 0;
    setupFetchMock({
      'GET /api/v1/workflow-runs': () =>
        ++calls < 2 ? runs(['wf-old']) : runs(['wf-new', 'wf-old']),
    });
    const { wrapper } = setup();

    const { result } = renderHook(() => useRetriedRun('wr-1', 'wf-new'), { wrapper });

    await waitFor(() => expect(result.current.runId).toBe('run-of-wf-new'), { timeout: 5_000 });
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('gives up after the bounded wait so the caller can fall back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setupFetchMock({ 'GET /api/v1/workflow-runs': () => runs(['wf-old']) });
      const { wrapper } = setup();

      const { result } = renderHook(() => useRetriedRun('wr-1', 'wf-new'), { wrapper });
      expect(result.current.timedOut).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(RETRIED_RUN_WAIT_MS + 1);
      });

      expect(result.current.timedOut).toBe(true);
      expect(result.current.runId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing until a retry has been made', () => {
    const fetchSpy = setupFetchMock({});
    const { wrapper } = setup();

    const { result } = renderHook(() => useRetriedRun(null, null), { wrapper });

    expect(result.current).toEqual({ runId: null, timedOut: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
