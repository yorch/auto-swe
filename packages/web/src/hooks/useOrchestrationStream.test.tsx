// @vitest-environment jsdom

import type { OrchestrationDetailDto } from '@auto-swe/shared/lib/orchestrationApi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { child, detail, message } from '@/test/orchestrationFixtures';
import {
  STREAM_BUSY_RETRY_MS,
  STREAM_SILENCE_MS,
  STREAM_UNSUPPORTED_TRIES,
  useOrchestrationStream,
} from './useOrchestrationStream';
import {
  type MessagesState,
  ORCHESTRATION_SAFETY_POLL_MS,
  orchestrationKey,
  orchestrationMessagesKey,
  orchestrationStreamKey,
  useOrchestration,
  useOrchestrationMessages,
} from './useOrchestrations';

const enc = new TextEncoder();

/** A response body the test writes to; reads fail the way a real one does when `signal` aborts. */
function sseBody(signal?: AbortSignal | null) {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      state.cancelled = true;
    },
    start(c) {
      ctrl = c;
    },
  });
  signal?.addEventListener('abort', () => {
    try {
      ctrl.error(new DOMException('aborted', 'AbortError'));
    } catch {
      // Already closed.
    }
  });
  return {
    body,
    close: () => ctrl.close(),
    push: (text: string) => ctrl.enqueue(enc.encode(text)),
    state,
  };
}

interface Call {
  headers: Record<string, string>;
  signal: AbortSignal;
  url: string;
}
type Step = ((call: Call) => Promise<Response> | Response) | 'sse';
type Body = ReturnType<typeof sseBody>;

const streamResponse = (body: ReadableStream<Uint8Array>) =>
  new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
const hang: Step = (call) =>
  new Promise<Response>((_resolve, reject) => {
    call.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

/** A fetch that answers successive `/events` calls from `steps` (the last repeats). */
function stubEvents(steps: Step[], others: (url: string) => unknown = () => ({})) {
  const calls: Call[] & { bodies?: Body[] } = [];
  const bodies: Body[] = [];
  calls.bodies = bodies;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('/events')) {
        return new Response(JSON.stringify(others(url)), {
          headers: { 'content-type': 'application/json' },
        });
      }
      const call: Call = {
        headers: (init?.headers ?? {}) as Record<string, string>,
        signal: init?.signal as AbortSignal,
        url,
      };
      calls.push(call);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)] as Step;
      if (step === 'sse') {
        const b = sseBody(call.signal);
        bodies.push(b);
        return streamResponse(b.body);
      }
      return step(call);
    })
  );
  return Object.assign(calls, { bodies });
}

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const flush = () => act(async () => vi.advanceTimersByTimeAsync(0));
const advance = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

let hidden = false;
const setHidden = (value: boolean) => {
  hidden = value;
  document.dispatchEvent(new Event('visibilitychange'));
};
const dataEvent = (event: string, id: string, data: unknown) =>
  `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const streamState = () => qc.getQueryData(orchestrationStreamKey('o1'));
const heldMessages = () =>
  qc.getQueryData<MessagesState>(orchestrationMessagesKey('o1'))?.messages.map((m) => m.id);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(1);
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(orchestrationKey('o1'), detail());
  qc.setQueryData<MessagesState>(orchestrationMessagesKey('o1'), {
    messages: [message({ id: 'm1' })],
    next: 'cursor-m1',
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useOrchestrationStream', () => {
  it('writes streamed messages, children and status into the caches and reports live', async () => {
    const calls = stubEvents(['sse']);
    const sse = { push: (t: string) => calls.bodies[0]?.push(t) };
    const { result } = renderHook(() => useOrchestrationStream('o1', true), { wrapper });
    await flush();
    expect(calls[0]?.url).toMatch(/\/api\/v1\/orchestrations\/o1\/events$/);
    expect(calls[0]?.headers.Accept).toBe('text/event-stream');
    // Resumes from the polled transcript's cursor rather than replaying it.
    expect(calls[0]?.headers['Last-Event-ID']).toBe('cursor-m1');
    sse.push('retry: 3000\n\n');
    await flush();
    expect(result.current).toBe('live');
    expect(streamState()).toBe('live');

    sse.push(
      dataEvent('message', 'cursor-m2', message({ createdAt: '2026-01-01T00:00:02Z', id: 'm2' }))
    );
    sse.push(dataEvent('child', 'cursor-m2', child({ id: 'ch2', status: 'RUNNING' })));
    sse.push(dataEvent('child', 'cursor-m2', child({ id: 'ch1', status: 'COMPLETED' })));
    sse.push(dataEvent('status', 'cursor-m2', { status: 'WAITING' }));
    await flush();
    expect(heldMessages()).toEqual(['m1', 'm2']);
    const held = qc.getQueryData<OrchestrationDetailDto>(orchestrationKey('o1'));
    expect(held?.status).toBe('WAITING');
    expect(held?.children.map((c) => [c.id, c.status])).toEqual([
      ['ch1', 'COMPLETED'],
      ['ch2', 'RUNNING'],
    ]);
  });

  it('merges a streamed message already polled once, in order, and leaves the poll cursor', async () => {
    const calls = stubEvents(['sse']);
    const sse = { push: (t: string) => calls.bodies[0]?.push(t) };
    renderHook(() => useOrchestrationStream('o1', true), { wrapper });
    await flush();
    sse.push(dataEvent('message', 'c1', message({ id: 'm1' })));
    sse.push(dataEvent('message', 'c3', message({ createdAt: '2026-01-01T00:00:03Z', id: 'm3' })));
    sse.push(dataEvent('message', 'c2', message({ createdAt: '2026-01-01T00:00:02Z', id: 'm2' })));
    await flush();
    expect(heldMessages()).toEqual(['m1', 'm2', 'm3']);
    expect(qc.getQueryData<MessagesState>(orchestrationMessagesKey('o1'))?.next).toBe('cursor-m1');
  });

  it('reconnects with backoff from the last event id after a drop', async () => {
    const calls = stubEvents(['sse', 'sse']);
    const first = {
      close: () => calls.bodies[0]?.close(),
      push: (t: string) => calls.bodies[0]?.push(t),
    };
    const second = { push: (t: string) => calls.bodies[1]?.push(t) };
    const { result } = renderHook(() => useOrchestrationStream('o1', true), { wrapper });
    await flush();
    first.push(
      dataEvent('message', 'c2', message({ createdAt: '2026-01-01T00:00:02Z', id: 'm2' }))
    );
    await flush();
    first.close();
    await flush();
    expect(result.current).toBe('reconnecting');
    expect(calls).toHaveLength(1);
    await advance(999);
    expect(calls).toHaveLength(1);
    await advance(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers['Last-Event-ID']).toBe('c2');
    second.push(
      dataEvent('message', 'c3', message({ createdAt: '2026-01-01T00:00:03Z', id: 'm3' }))
    );
    await flush();
    expect(result.current).toBe('live');
    expect(heldMessages()).toEqual(['m1', 'm2', 'm3']);
  });

  it('doubles the delay across failures in a row and falls to polling after three', async () => {
    const calls = stubEvents([() => Promise.reject(new TypeError('network'))]);
    const { result } = renderHook(() => useOrchestrationStream('o1', true), { wrapper });
    await flush();
    expect(calls).toHaveLength(1);
    expect(result.current).toBe('reconnecting');
    await advance(1_000);
    expect(calls).toHaveLength(2);
    await advance(2_000);
    expect(calls).toHaveLength(3);
    await advance(3_999);
    expect(calls).toHaveLength(3);
    await advance(1);
    expect(calls).toHaveLength(4);
    expect(result.current).toBe('polling');
  });

  it('reconnects at once, without a failure, when the server ends the stream at its time limit', async () => {
    const calls = stubEvents(['sse', 'sse']);
    const first = { push: (t: string) => calls.bodies[0]?.push(t) };
    renderHook(() => useOrchestrationStream('o1', true), { wrapper });
    await flush();
    first.push(
      dataEvent('message', 'c2', message({ createdAt: '2026-01-01T00:00:02Z', id: 'm2' }))
    );
    first.push(dataEvent('done', 'c2', { reason: 'timeout' }));
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers['Last-Event-ID']).toBe('c2');
  });

  it('falls back to polling on a 429 and tries again later', async () => {
    const calls = stubEvents([
      () =>
        new Response(JSON.stringify({ error: { code: 'TOO_MANY_STREAMS' } }), {
          headers: { 'content-type': 'application/json' },
          status: 429,
        }),
      'sse',
    ]);
    const sse = { push: (t: string) => calls.bodies[0]?.push(t) };
    const { result } = renderHook(() => useOrchestrationStream('o1', true), { wrapper });
    await flush();
    expect(result.current).toBe('polling');
    expect(streamState()).toBe('polling');
    await advance(STREAM_BUSY_RETRY_MS - 1);
    expect(calls).toHaveLength(1);
    await advance(2);
    expect(calls).toHaveLength(2);
    sse.push(': ping\n\n');
    await flush();
    expect(result.current).toBe('live');
  });

  it('falls back to polling when the answer is not an event stream, and stops trying', async () => {
    const calls = stubEvents([
      () => new Response('<html>buffered</html>', { headers: { 'content-type': 'text/html' } }),
    ]);
    const { result } = renderHook(() => useOrchestrationStream('o1', true), { wrapper });
    await flush();
    expect(result.current).toBe('polling');
    await advance(60 * 60_000);
    expect(calls).toHaveLength(STREAM_UNSUPPORTED_TRIES);
    expect(result.current).toBe('polling');
  });

  it('treats silence for the watchdog window as a dead stream', async () => {
    const calls = stubEvents([hang]);
    const { result } = renderHook(() => useOrchestrationStream('o1', true), { wrapper });
    await flush();
    await advance(STREAM_SILENCE_MS - 1);
    expect(calls[0]?.signal.aborted).toBe(false);
    await advance(2);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(result.current).toBe('polling');
    await advance(1_000);
    expect(calls).toHaveLength(2);
  });

  it('counts heartbeats as life', async () => {
    const calls = stubEvents(['sse']);
    const sse = { push: (t: string) => calls.bodies[0]?.push(t) };
    const { result } = renderHook(() => useOrchestrationStream('o1', true), { wrapper });
    await flush();
    for (let i = 0; i < 4; i += 1) {
      sse.push(': ping\n\n');
      await advance(STREAM_SILENCE_MS - 1_000);
    }
    expect(calls).toHaveLength(1);
    expect(result.current).toBe('live');
  });

  it('pauses while the tab is hidden and resumes with a catch-up read when it returns', async () => {
    const calls = stubEvents(['sse', 'sse']);
    const first = {
      push: (t: string) => calls.bodies[0]?.push(t),
      state: {
        get cancelled() {
          return calls[0]?.signal.aborted === true;
        },
      },
    };
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useOrchestrationStream('o1', true), { wrapper });
    await flush();
    first.push(
      dataEvent('message', 'c2', message({ createdAt: '2026-01-01T00:00:02Z', id: 'm2' }))
    );
    await flush();
    expect(result.current).toBe('live');
    act(() => setHidden(true));
    await flush();
    expect(first.state.cancelled).toBe(true);
    expect(result.current).toBe('paused');
    await advance(5 * 60_000);
    expect(calls).toHaveLength(1);
    invalidate.mockClear();
    act(() => setHidden(false));
    await flush();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: orchestrationKey('o1') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: orchestrationMessagesKey('o1') });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers['Last-Event-ID']).toBe('c2');
  });

  it('aborts the request on unmount', async () => {
    const calls = stubEvents([hang]);
    const { unmount } = renderHook(() => useOrchestrationStream('o1', true), { wrapper });
    await flush();
    expect(calls[0]?.signal.aborted).toBe(false);
    unmount();
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(streamState()).toBe('idle');
    await advance(10 * 60_000);
    expect(calls).toHaveLength(1);
  });

  it('stops when the orchestration finishes, with a last read of the detail', async () => {
    const calls = stubEvents(['sse']);
    const sse = { push: (t: string) => calls.bodies[0]?.push(t) };
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result, rerender } = renderHook(({ on }) => useOrchestrationStream('o1', on), {
      initialProps: { on: true },
      wrapper,
    });
    await flush();
    sse.push(': ping\n\n');
    await flush();
    expect(result.current).toBe('live');
    invalidate.mockClear();
    rerender({ on: false });
    await flush();
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(result.current).toBe('idle');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: orchestrationKey('o1') });
    await advance(10 * 60_000);
    expect(calls).toHaveLength(1);
  });

  describe('re-reading the detail', () => {
    const reads = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter(
        (c) =>
          JSON.stringify((c[0] as { queryKey?: unknown })?.queryKey) ===
          JSON.stringify(orchestrationKey('o1'))
      ).length;

    it('patches a child cost into the cache and re-reads at most once per 15 seconds', async () => {
      const calls = stubEvents(['sse']);
      const sse = { push: (t: string) => calls.bodies[0]?.push(t) };
      const invalidate = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useOrchestrationStream('o1', true), { wrapper });
      await flush();
      sse.push(': ping\n\n');
      await flush();
      invalidate.mockClear();
      // A cost that grows every 1.5 s for 14 s: the cache follows, the server is not asked.
      for (let i = 1; i <= 9; i += 1) {
        sse.push(dataEvent('child', 'c1', child({ costUsd: 0.42 + i, id: 'ch1' })));
        await advance(1_500);
      }
      expect(reads(invalidate)).toBe(0);
      const held = qc.getQueryData<OrchestrationDetailDto>(orchestrationKey('o1'));
      expect(held?.children[0]?.costUsd).toBeCloseTo(9.42, 5);
      expect(held?.cost.childrenUsd).toBeCloseTo(9.42, 5);
      expect(held?.cost.totalUsd).toBeCloseTo(9.52, 5);
      // The next 15 s window closes with one read, however many events came in it.
      await advance(2_000);
      expect(reads(invalidate)).toBe(1);
      for (let i = 10; i <= 20; i += 1) {
        sse.push(dataEvent('child', 'c1', child({ costUsd: 0.42 + i, id: 'ch1' })));
        await advance(1_500);
      }
      expect(reads(invalidate)).toBe(2);
    });

    it('re-reads once, debounced, when a child changes status or a status event arrives', async () => {
      const calls = stubEvents(['sse']);
      const sse = { push: (t: string) => calls.bodies[0]?.push(t) };
      const invalidate = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useOrchestrationStream('o1', true), { wrapper });
      await flush();
      sse.push(': ping\n\n');
      await flush();
      invalidate.mockClear();
      sse.push(dataEvent('child', 'c1', child({ id: 'ch1', status: 'COMPLETED' })));
      sse.push(dataEvent('child', 'c1', child({ costUsd: 5, id: 'ch1', status: 'COMPLETED' })));
      await advance(1_600);
      expect(reads(invalidate)).toBe(1);
      sse.push(dataEvent('status', 'c2', { status: 'WAITING' }));
      await advance(1_600);
      expect(reads(invalidate)).toBe(2);
      // A child that is new to the page is structural too.
      sse.push(dataEvent('child', 'c3', child({ id: 'ch9' })));
      await advance(1_600);
      expect(reads(invalidate)).toBe(3);
    });
  });

  it('opens nothing while disabled', async () => {
    const calls = stubEvents([hang]);
    const { result } = renderHook(() => useOrchestrationStream('o1', false), { wrapper });
    await advance(60_000);
    expect(calls).toHaveLength(0);
    expect(result.current).toBe('idle');
  });
});

describe('polling beside the stream', () => {
  function pollers() {
    const hits = { detail: 0, messages: 0 };
    const answer = (url: string) => {
      if (url.includes('/messages')) {
        hits.messages += 1;
        return { data: [], next: 'cursor-m1' };
      }
      hits.detail += 1;
      return { data: detail() };
    };
    return { answer, hits };
  }
  const both = () => {
    useOrchestration('o1');
    useOrchestrationMessages('o1', true);
    return useOrchestrationStream('o1', true);
  };

  it('slows to the safety interval while the stream is live and returns to 3 s when it is not', async () => {
    const { answer, hits } = pollers();
    const calls = stubEvents(['sse'], answer);
    const sse = {
      close: () => calls.bodies[0]?.close(),
      push: (t: string) => calls.bodies[0]?.push(t),
    };
    qc.removeQueries({ queryKey: orchestrationKey('o1') });
    qc.removeQueries({ queryKey: orchestrationMessagesKey('o1') });
    const { result } = renderHook(both, { wrapper });
    await flush();
    sse.push(': ping\n\n');
    await flush();
    expect(result.current).toBe('live');
    const before = hits.detail;
    await advance(ORCHESTRATION_SAFETY_POLL_MS - 1_000);
    expect(hits.detail).toBe(before);
    await advance(2_000);
    expect(hits.detail).toBe(before + 1);

    // The stream breaks: the next reads come every 3 s, the first one straight away.
    sse.close();
    await flush();
    const afterBreak = hits.detail;
    expect(afterBreak).toBeGreaterThan(before + 1);
    await advance(3_100);
    expect(hits.detail).toBeGreaterThan(afterBreak);
  });

  it('keeps the 3 s polling when the stream cannot be established', async () => {
    const { answer, hits } = pollers();
    stubEvents(
      [() => new Response('no', { headers: { 'content-type': 'text/plain' }, status: 429 })],
      answer
    );
    qc.removeQueries({ queryKey: orchestrationKey('o1') });
    qc.removeQueries({ queryKey: orchestrationMessagesKey('o1') });
    renderHook(both, { wrapper });
    await flush();
    const start = hits.detail;
    await advance(9_100);
    expect(hits.detail).toBeGreaterThanOrEqual(start + 3);
  });
});
