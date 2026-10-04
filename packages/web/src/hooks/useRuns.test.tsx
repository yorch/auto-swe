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

  it('bases the cursor on the last read, not the newest trace, once there is one', () => {
    const cursor = traceTailCursor(
      [trace('a', '2026-09-01T10:00:30.000Z')],
      '2026-09-01T10:05:00.000Z'
    );
    expect(cursor).toBe('2026-09-01T10:04:50.000Z');
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
        total: 2,
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
        expect.stringMatching(/\/api\/v1\/workflow-runs\/run-1\?includeSpec=false$/),
        expect.stringContaining(
          `/api/v1/workflow-runs/run-1/traces?since=${encodeURIComponent('2026-09-01T09:59:50.000Z')}`
        ),
      ])
    );
    await waitFor(() => expect(result.current.data?.traces.map((t) => t.id)).toEqual(['t1', 't2']));
  });

  it('reads the spec snapshot once and carries it through every later poll', async () => {
    let steps = 1;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/traces')) {
        return json({ data: [], serverTime: '2026-09-01T10:00:40.000Z', total: 0 });
      }
      const withSpec = !url.includes('includeSpec=false');
      return json({
        data: {
          id: 'run-1',
          status: 'RUNNING',
          steps: Array.from({ length: steps }, (_, i) => ({ id: `s${i}` })),
          traces: [],
          ...(withSpec ? { specSnapshot: { nodes: ['a'] } } : {}),
        },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const { wrapper } = setup();
    const { result } = renderHook(() => useWorkflowRun('run-1'), { wrapper });
    await waitFor(() => expect(result.current.data?.specSnapshot).toEqual({ nodes: ['a'] }));

    steps = 2;
    await act(() => result.current.refetch());

    // Steps moved on, the spec stayed, and the poll never asked for it again.
    await waitFor(() => expect(result.current.data?.steps).toHaveLength(2));
    expect(result.current.data?.specSnapshot).toEqual({ nodes: ['a'] });
    const runReads = fetchSpy.mock.calls
      .map(([u]) => String(u))
      .filter((u) => !u.includes('/traces'));
    expect(runReads[0]).not.toContain('includeSpec');
    expect(runReads.slice(1).every((u) => u.includes('includeSpec=false'))).toBe(true);
  });

  /**
   * A fake gateway holding `server.traces` and `server.status`: the detail
   * route returns every trace only with `?includeTraces=true`, and the tail
   * returns what the test hands it, plus the run's true count.
   */
  function fakeGateway(server: {
    status: string;
    traces: AgentTraceRecord[];
    tail: () => AgentTraceRecord[];
  }) {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/traces')) {
        return json({
          data: server.tail(),
          serverTime: '2026-09-01T10:00:40.000Z',
          total: server.traces.length,
        });
      }
      const traces = url.includes('includeTraces=true') ? server.traces : [];
      return json({ data: { id: 'run-1', status: server.status, steps: [], traces } });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const fullReads = () =>
      fetchSpy.mock.calls.filter(([u]) => String(u).includes('includeTraces=true')).length;
    return { fetchSpy, fullReads };
  }

  it('re-reads every trace when one landed behind the cursor', async () => {
    const t1 = trace('t1', '2026-09-01T10:00:00.000Z');
    const t3 = trace('t3', '2026-09-01T10:00:30.000Z');
    // Written by a slow insert: committed after t3, stamped long before it.
    const late = trace('late', '2026-09-01T09:59:00.000Z');
    const server = { status: 'RUNNING', tail: () => [t3], traces: [t1] };
    const { fullReads } = fakeGateway(server);
    const { wrapper } = setup();
    const { result } = renderHook(() => useWorkflowRun('run-1'), { wrapper });
    await waitFor(() => expect(result.current.data?.traces).toHaveLength(1));
    expect(fullReads()).toBe(1);

    // The tail only returns t3, outside whose window `late` sits.
    server.traces = [late, t1, t3];
    await act(() => result.current.refetch());

    expect(fullReads()).toBe(2);
    await waitFor(() =>
      expect(result.current.data?.traces.map((t) => t.id)).toEqual(['late', 't1', 't3'])
    );
  });

  it('does not re-read every trace while the tail accounts for them all', async () => {
    const t1 = trace('t1', '2026-09-01T10:00:00.000Z');
    const t2 = trace('t2', '2026-09-01T10:00:04.000Z');
    const server = { status: 'RUNNING', tail: () => [t2], traces: [t1] };
    const { fullReads } = fakeGateway(server);
    const { wrapper } = setup();
    const { result } = renderHook(() => useWorkflowRun('run-1'), { wrapper });
    await waitFor(() => expect(result.current.data?.traces).toHaveLength(1));

    server.traces = [t1, t2];
    await act(() => result.current.refetch());
    await act(() => result.current.refetch());

    await waitFor(() => expect(result.current.data?.traces.map((t) => t.id)).toEqual(['t1', 't2']));
    expect(fullReads()).toBe(1);
  });

  it('re-reads every trace once when the run turns terminal', async () => {
    const t1 = trace('t1', '2026-09-01T10:00:00.000Z');
    const server = { status: 'RUNNING', tail: () => [t1], traces: [t1] };
    const { fullReads } = fakeGateway(server);
    const { wrapper } = setup();
    const { result } = renderHook(() => useWorkflowRun('run-1'), { wrapper });
    await waitFor(() => expect(result.current.data?.traces).toHaveLength(1));

    server.status = 'SUCCESS';
    await act(() => result.current.refetch());
    expect(fullReads()).toBe(2);
    await waitFor(() => expect(result.current.data?.status).toBe('SUCCESS'));

    // Already terminal when held: later polls go back to the tail.
    await act(() => result.current.refetch());
    expect(fullReads()).toBe(2);
  });

  it('stops re-downloading the last batch while the run is idle', async () => {
    const t1 = trace('t1', '2026-09-01T10:00:00.000Z');
    const reads = [
      '2026-09-01T10:00:03.000Z',
      '2026-09-01T10:00:20.000Z',
      '2026-09-01T10:00:40.000Z',
    ];
    const sinces: string[] = [];
    const tailed: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://gw');
        if (url.pathname.endsWith('/traces')) {
          const since = url.searchParams.get('since') as string;
          sinces.push(since);
          // The server honours the cursor, like the real route.
          const data = [t1].filter((t) => Date.parse(t.createdAt) >= Date.parse(since));
          tailed.push(data.length);
          return json({ data, serverTime: reads[sinces.length - 1], total: 1 });
        }
        return json({ data: { id: 'run-1', status: 'RUNNING', steps: [], traces: [t1] } });
      })
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useWorkflowRun('run-1'), { wrapper });
    await waitFor(() => expect(result.current.data?.traces).toHaveLength(1));

    for (let i = 0; i < 3; i++) {
      await act(() => result.current.refetch());
    }

    // First from the newest trace, then from each previous read.
    expect(sinces).toEqual([
      '2026-09-01T09:59:50.000Z',
      '2026-09-01T09:59:53.000Z',
      '2026-09-01T10:00:10.000Z',
    ]);
    // Once the last read is past the overlap, the poll carries no traces.
    expect(tailed).toEqual([1, 1, 0]);
    expect(result.current.data?.traces.map((t) => t.id)).toEqual(['t1']);
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
    // Both are whole-run reads, never the tail; the second also skips the spec it holds.
    expect(urls[0]).toMatch(/run-1\?fullTraces=true$/);
    expect(urls[1]).toMatch(/run-1\?fullTraces=true&includeSpec=false$/);
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
            ? json({ data: [], total: 0 })
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
