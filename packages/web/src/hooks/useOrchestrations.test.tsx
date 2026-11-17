// @vitest-environment jsdom

import type { OrchestrationMessageDto } from '@auto-swe/shared/lib/orchestrationApi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock } from '@/test/rtl-helpers';
import {
  mergeMessages,
  orchestrationRefetchInterval,
  useAttachRepo,
  useDecideApproval,
  useLaunchOrchestration,
  useOrchestrationMessages,
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
    expect(urls[0]).toMatch(/\/messages$/);
    expect(urls[1]).toMatch(/\/messages\?after=cur-1$/);
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
