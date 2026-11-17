// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LATEST_TOOL_CALL_POLL_MS, useLatestToolCall } from './useLatestToolCall';

afterEach(() => vi.unstubAllGlobals());

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const item = (n: number) => ({
  id: `trace:${n}`,
  kind: 'tool_call',
  summary: `call ${n}`,
  ts: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
});

/** The activity feed: oldest first, `size` per page, a cursor to the next page. */
function feed(items: ReturnType<typeof item>[], size: number) {
  const urls: string[] = [];
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://x.test');
    urls.push(url.pathname + url.search);
    const since = url.searchParams.get('since');
    const from = Number(url.searchParams.get('cursor') ?? 0);
    const pool = since ? items.filter((i) => i.ts > since) : items;
    const data = pool.slice(from, from + size);
    const more = from + size < pool.length;
    return new Response(JSON.stringify({ data, nextCursor: more ? String(from + size) : null }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });
  });
  vi.stubGlobal('fetch', spy);
  return { spy, urls };
}

describe('useLatestToolCall', () => {
  it('returns the newest call even when the feed runs past one page', async () => {
    const items = Array.from({ length: 7 }, (_, i) => item(i + 1));
    feed(items, 3);
    const { result } = renderHook(() => useLatestToolCall('run-1', false), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.summary).toBe('call 7'));
  });

  it('asks only for tool calls, and not at all without a run', async () => {
    const { spy, urls } = feed([item(1)], 100);
    const idle = renderHook(() => useLatestToolCall(null, true), { wrapper: wrapper() });
    expect(idle.result.current.fetchStatus).toBe('idle');
    expect(spy).not.toHaveBeenCalled();
    renderHook(() => useLatestToolCall('run-1', false), { wrapper: wrapper() });
    await waitFor(() => expect(urls).toHaveLength(1));
    expect(urls[0]).toContain('kinds=tool_call');
  });

  it('polls a running lane for what is newer, and never polls a finished one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const items = [item(1), item(2)];
      const { spy, urls } = feed(items, 100);
      const running = renderHook(() => useLatestToolCall('run-1', true), { wrapper: wrapper() });
      await waitFor(() => expect(running.result.current.data?.summary).toBe('call 2'));
      items.push(item(3));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LATEST_TOOL_CALL_POLL_MS + 100);
      });
      await waitFor(() => expect(running.result.current.data?.summary).toBe('call 3'));
      // The second read only asked for what came after the newest call held.
      expect(urls.at(-1)).toContain(`since=${encodeURIComponent(item(2).ts)}`);
      running.unmount();

      spy.mockClear();
      const finished = renderHook(() => useLatestToolCall('run-2', false), { wrapper: wrapper() });
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LATEST_TOOL_CALL_POLL_MS * 5);
      });
      expect(spy).toHaveBeenCalledTimes(1);
      finished.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes one last read when the lane stops running', async () => {
    const items = [item(1)];
    feed(items, 100);
    const { result, rerender } = renderHook(({ poll }) => useLatestToolCall('run-1', poll), {
      initialProps: { poll: true },
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.data?.summary).toBe('call 1'));
    items.push(item(2));
    rerender({ poll: false });
    await waitFor(() => expect(result.current.data?.summary).toBe('call 2'));
  });
});
