// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { child, detail } from '@/test/orchestrationFixtures';
import { AgentsColumn } from './AgentsColumn';

// The real run and activity hooks run over a stubbed gateway so the request count is observable.

function gateway() {
  const counts = { activity: 0, runs: 0 };
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    if (path.includes('/activity')) {
      counts.activity += 1;
      return json({
        data: [
          { id: 'trace:1', kind: 'tool_call', summary: 'older call', ts: '2026-01-01T00:00:01Z' },
          { id: 'trace:2', kind: 'tool_call', summary: 'newest call', ts: '2026-01-01T00:00:02Z' },
        ],
        nextCursor: null,
      });
    }
    if (path.startsWith('/api/v1/workflow-runs?')) {
      counts.runs += 1;
      const wr = new URL(path, 'http://x.test').searchParams.get('workRequestId');
      return json({ data: [{ id: `run-${wr}` }], meta: { limit: 5, offset: 0, total: 1 } });
    }
    return json({ data: [], meta: { limit: 100, offset: 0, total: 0 } });
  });
  vi.stubGlobal('fetch', spy);
  return counts;
}

function mount(d: ReturnType<typeof detail>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AgentsColumn detail={d} />
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AgentsColumn requests', () => {
  it('shows the newest tool call, read from the end of the feed', async () => {
    gateway();
    mount(detail({ children: [child({ status: 'COMPLETED' })], status: 'COMPLETED' }));
    expect(await screen.findByText('newest call')).toBeTruthy();
    expect(screen.queryByText('older call')).toBeNull();
  });

  it('reads finished lanes once and never polls them', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const counts = gateway();
    mount(
      detail({
        children: [
          child({ id: 'a', status: 'COMPLETED', workRequestId: 'wr-a' }),
          child({ id: 'b', status: 'FAILED', workRequestId: 'wr-b' }),
          child({ id: 'c', status: 'CANCELLED', workRequestId: 'wr-c' }),
        ],
        status: 'COMPLETED',
      })
    );
    await waitFor(() => expect(counts.activity).toBe(3));
    const settled = { ...counts };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(counts).toEqual(settled);
    expect(settled.runs).toBe(3);
  });

  it('does not poll the lanes of a finished orchestration, even with a stale running child', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const counts = gateway();
    mount(detail({ children: [child({ status: 'RUNNING' })], status: 'CANCELLED' }));
    await waitFor(() => expect(counts.activity).toBe(1));
    const settled = { ...counts };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(counts).toEqual(settled);
  });

  it('skips the run lookup when the child names its run, and polls only the running lane', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const counts = gateway();
    mount(
      detail({
        children: [
          child({ id: 'a', runId: 'run-a', status: 'RUNNING', workRequestId: 'wr-a' }),
          child({ id: 'b', runId: 'run-b', status: 'COMPLETED', workRequestId: 'wr-b' }),
        ],
      })
    );
    await waitFor(() => expect(counts.activity).toBe(2));
    expect(counts.runs).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_500);
    });
    // One more read, for the running lane only.
    expect(counts.activity).toBe(3);
  });

  it('looks a running lane’s run up until it is found, then stops asking', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const counts = gateway();
    mount(detail({ children: [child({ status: 'RUNNING', workRequestId: 'wr-a' })] }));
    await waitFor(() => expect(counts.runs).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(counts.runs).toBe(1);
  });
});
