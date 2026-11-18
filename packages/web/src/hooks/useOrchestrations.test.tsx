// @vitest-environment jsdom

import type { OrchestrationMessageDto } from '@auto-swe/shared/lib/orchestrationApi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detail as detailFixture } from '@/test/orchestrationFixtures';
import { bodyOf, setupFetchMock } from '@/test/rtl-helpers';
import {
  MESSAGES_PAGE_SIZE,
  type MessagesState,
  mergeMessages,
  orchestrationMessagesKey,
  orchestrationRefetchInterval,
  useAttachRepo,
  useDecideApproval,
  useLaunchOrchestration,
  useOrchestration,
  useOrchestrationConnections,
  useOrchestrationMessages,
  useOrchestrations,
  useSendOrchestrationMessage,
} from './useOrchestrations';

afterEach(() => vi.unstubAllGlobals());

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const msg = (id: string, createdAt: string): OrchestrationMessageDto => ({
  authorId: null,
  body: id,
  childId: null,
  createdAt,
  id,
  kind: 'TEXT',
  payload: null,
  role: 'ORCHESTRATOR',
});

describe('mergeMessages', () => {
  it('appends new messages, drops duplicates by id and keeps time order', () => {
    const held = [msg('a', '2026-01-01T00:00:01Z'), msg('b', '2026-01-01T00:00:02Z')];
    const merged = mergeMessages(held, [
      msg('b', '2026-01-01T00:00:02Z'),
      msg('c', '2026-01-01T00:00:03Z'),
    ]);
    expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(mergeMessages(held, [msg('a', '2026-01-01T00:00:01Z')])).toBe(held);
  });
});

describe('orchestrationRefetchInterval', () => {
  it('polls while active or waiting and stops once finished', () => {
    expect(orchestrationRefetchInterval('ACTIVE')).toBe(3000);
    expect(orchestrationRefetchInterval('WAITING')).toBe(3000);
    for (const s of ['COMPLETED', 'CANCELLED', 'FAILED', undefined] as const) {
      expect(orchestrationRefetchInterval(s)).toBe(false);
    }
  });
});

describe('useOrchestrationMessages', () => {
  it('reads the cursor from the last page and appends without duplicating', async () => {
    let call = 0;
    const urls: string[] = [];
    const fetchSpy = setupFetchMock({
      '/api/v1/orchestrations/o1/messages': () => {
        call += 1;
        return call === 1
          ? { data: [msg('a', '2026-01-01T00:00:01Z')], next: 'cur-1' }
          : {
              data: [msg('a', '2026-01-01T00:00:01Z'), msg('b', '2026-01-01T00:00:02Z')],
              next: 'cur-2',
            };
      },
    });
    const { result } = renderHook(() => useOrchestrationMessages('o1', false), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.data?.messages).toHaveLength(1));
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.data?.messages.map((m) => m.id)).toEqual(['a', 'b']));
    expect(result.current.data?.next).toBe('cur-2');
    for (const [url] of fetchSpy.mock.calls) {
      urls.push(String(url));
    }
    expect(urls[0]).toMatch(/\/messages\?limit=200$/);
    expect(urls[1]).toMatch(/\/messages\?limit=200&after=cur-1$/);
  });

  it('keeps the cursor when a poll comes back empty', async () => {
    let call = 0;
    setupFetchMock({
      '/api/v1/orchestrations/o1/messages': () => {
        call += 1;
        return call === 1
          ? { data: [msg('a', '2026-01-01T00:00:01Z')], next: 'cur-1' }
          : { data: [], next: null };
      },
    });
    const { result } = renderHook(() => useOrchestrationMessages('o1', false), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.data?.next).toBe('cur-1'));
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.data?.next).toBe('cur-1');
    expect(result.current.data?.messages).toHaveLength(1);
  });

  it('keeps a message the stream delivered while a poll was in flight', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let call = 0;
    setupFetchMock({
      '/api/v1/orchestrations/o1/messages': () => {
        call += 1;
        if (call === 1) {
          return { data: [msg('a', '2026-01-01T00:00:01Z')], next: 'cur-1' };
        }
        // The stream writes message b into the cache while this request is out.
        qc.setQueryData<MessagesState>(orchestrationMessagesKey('o1'), (prev) =>
          prev
            ? {
                ...prev,
                messages: mergeMessages(prev.messages, [msg('b', '2026-01-01T00:00:02Z')]),
              }
            : prev
        );
        return { data: [], next: null };
      },
    });
    const { result } = renderHook(() => useOrchestrationMessages('o1', false), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() => expect(result.current.data?.next).toBe('cur-1'));
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.data?.messages.map((m) => m.id)).toEqual(['a', 'b']));
    const held = qc.getQueryData<MessagesState>(orchestrationMessagesKey('o1'));
    expect(held?.messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(held?.next).toBe('cur-1');
  });

  it('polls while live and does not poll when finished', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fetchSpy = setupFetchMock({
        '/api/v1/orchestrations/o1/messages': () => ({ data: [], next: null }),
      });
      const live = renderHook(() => useOrchestrationMessages('o1', true), { wrapper: wrapper() });
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      live.unmount();

      const done = setupFetchMock({
        '/api/v1/orchestrations/o1/messages': () => ({ data: [], next: null }),
      });
      renderHook(() => useOrchestrationMessages('o1', false), { wrapper: wrapper() });
      await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(done).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('mutations', () => {
  it('post to the launcher-only routes with the contract bodies', async () => {
    const fetchSpy = setupFetchMock({
      '/api/v1/orchestrations': () => ({ data: [] }),
      '/api/v1/orchestrations/o1': () => ({}),
      '/api/v1/orchestrations/o1/messages': () => ({ data: [], next: null }),
      'POST /api/v1/orchestrations/o1/approvals/ap1': () => ({}),
      'POST /api/v1/orchestrations/o1/attach': () => ({}),
      'POST /api/v1/orchestrations/o1/messages': () => ({}),
    });
    const w = wrapper();
    const send = renderHook(() => useSendOrchestrationMessage('o1'), { wrapper: w });
    const attach = renderHook(() => useAttachRepo('o1'), { wrapper: w });
    const decide = renderHook(() => useDecideApproval('o1'), { wrapper: w });
    await act(async () => {
      await send.result.current.mutateAsync('hello');
      await attach.result.current.mutateAsync('repo-1');
      await decide.result.current.mutateAsync({ approvalId: 'ap1', decision: 'DENY' });
    });
    expect(bodyOf(fetchSpy, '/o1/messages')).toEqual({ body: 'hello' });
    expect(bodyOf(fetchSpy, '/o1/attach')).toEqual({ repoId: 'repo-1' });
    expect(bodyOf(fetchSpy, '/o1/approvals/ap1')).toEqual({ decision: 'DENY' });
  });

  it('launches with an Idempotency-Key header', async () => {
    const fetchSpy = setupFetchMock({
      'POST /api/v1/orchestrations': () => ({
        data: { orchestrationId: 'o9', status: 'ACTIVE', workflowId: 'orch-o9' },
      }),
    });
    const { result } = renderHook(() => useLaunchOrchestration(), { wrapper: wrapper() });
    let launched: { orchestrationId: string } | undefined;
    await act(async () => {
      launched = await result.current.mutateAsync({ body: { task: 't' }, idempotencyKey: 'key-1' });
    });
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('key-1');
    expect(launched?.orchestrationId).toBe('o9');
  });
});

/** A fetch that serves a transcript of `all` messages the way the gateway pages it. */
function transcriptGateway(all: OrchestrationMessageDto[]) {
  const urls: string[] = [];
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://x.test');
    urls.push(url.pathname + url.search);
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const after = url.searchParams.get('after');
    const start = after ? Number(after) : 0;
    const data = all.slice(start, start + limit);
    return new Response(
      JSON.stringify({ data, next: data.length ? String(start + data.length) : null }),
      {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }
    );
  });
  vi.stubGlobal('fetch', spy);
  return { spy, urls };
}

const many = (count: number): OrchestrationMessageDto[] =>
  Array.from({ length: count }, (_, i) =>
    msg(
      `m${String(i).padStart(4, '0')}`,
      new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 1000).toISOString()
    )
  );

describe('useOrchestrationMessages paging', () => {
  it('reads every page of a transcript longer than one page', async () => {
    const total = MESSAGES_PAGE_SIZE * 2 + 50;
    const { urls } = transcriptGateway(many(total));
    const { result } = renderHook(() => useOrchestrationMessages('o1', false), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.data?.messages).toHaveLength(total));
    expect(result.current.data?.messages[total - 1].id).toBe(
      `m${String(total - 1).padStart(4, '0')}`
    );
    // Three requests, each following the cursor of the page before it.
    expect(urls).toHaveLength(3);
    expect(urls[1]).toContain(`after=${MESSAGES_PAGE_SIZE}`);
  });

  it('stops after an exactly full last page with one empty read', async () => {
    const { urls } = transcriptGateway(many(MESSAGES_PAGE_SIZE));
    const { result } = renderHook(() => useOrchestrationMessages('o1', false), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.data?.messages).toHaveLength(MESSAGES_PAGE_SIZE));
    expect(urls).toHaveLength(2);
  });

  it('makes one final read, draining every page, when live turns off', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const all = many(10);
      const served = { messages: all.slice(0, 3) };
      const spy = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://x.test');
        const after = Number(url.searchParams.get('after') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const data = served.messages.slice(after, after + limit);
        return new Response(
          JSON.stringify({ data, next: data.length ? String(after + data.length) : null }),
          { headers: { 'content-type': 'application/json' }, status: 200 }
        );
      });
      vi.stubGlobal('fetch', spy);
      const { result, rerender } = renderHook(({ live }) => useOrchestrationMessages('o1', live), {
        initialProps: { live: true },
        wrapper: wrapper(),
      });
      await waitFor(() => expect(result.current.data?.messages).toHaveLength(3));
      // The orchestration finishes and writes its closing messages; no poll is due yet.
      served.messages = all;
      rerender({ live: false });
      await waitFor(() => expect(result.current.data?.messages).toHaveLength(10));
      const calls = spy.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(spy.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('restarting a completed orchestration', () => {
  it('watches the status after a message until the orchestration is active again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const state = { flipAfterGets: 2, gets: 0, status: 'COMPLETED' as 'COMPLETED' | 'ACTIVE' };
      const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://x.test');
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            headers: { 'content-type': 'application/json' },
            status: 200,
          });
        if (init?.method === 'POST') {
          return json({});
        }
        if (url.pathname.endsWith('/messages')) {
          return json({ data: [], next: null });
        }
        state.gets += 1;
        if (state.gets > state.flipAfterGets) {
          state.status = 'ACTIVE';
        }
        return json({ data: detailFixture({ status: state.status }) });
      });
      vi.stubGlobal('fetch', spy);
      const w = wrapper();
      const detail = renderHook(() => useOrchestration('o1'), { wrapper: w });
      const send = renderHook(() => useSendOrchestrationMessage('o1'), { wrapper: w });
      await waitFor(() => expect(detail.result.current.data?.status).toBe('COMPLETED'));
      // Without a send, a finished orchestration is not polled.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(state.gets).toBe(1);
      await act(async () => {
        await send.result.current.mutateAsync('start again');
      });
      // The invalidation re-reads once (still COMPLETED), then the poll finds it active.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(7000);
      });
      await waitFor(() => expect(detail.result.current.data?.status).toBe('ACTIVE'));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useOrchestrations', () => {
  it('asks for one page at an offset and returns the total', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ data: [], limit: 25, offset: 50, total: 77 }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        });
      })
    );
    const { result } = renderHook(() => useOrchestrations(50), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.total).toBe(77));
    expect(urls[0]).toMatch(/\/api\/v1\/orchestrations\?limit=25&offset=50$/);
  });
});

describe('useOrchestrationConnections', () => {
  it('reads a team’s connections from the orchestration route, and only with a team', async () => {
    const spy = setupFetchMock({
      '/api/v1/orchestrations/connections': () => ({ data: [{ id: 'c1', name: 'Linear' }] }),
    });
    const none = renderHook(() => useOrchestrationConnections(''), { wrapper: wrapper() });
    expect(none.result.current.fetchStatus).toBe('idle');
    const { result } = renderHook(() => useOrchestrationConnections('t 1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toEqual([{ id: 'c1', name: 'Linear' }]));
    expect(String(spy.mock.calls[0][0])).toMatch(/\/connections\?teamId=t%201$/);
  });
});
