// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePlanJob } from './useRunPlans';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function wrapper() {
  const qc = new QueryClient();
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });

describe('usePlanJob', () => {
  it('keeps polling while running and stops once done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    const spy = vi.fn(async () => {
      calls += 1;
      return json({ data: calls < 3 ? { status: 'running' } : { planId: 'p', status: 'done' } });
    });
    vi.stubGlobal('fetch', spy);
    const { result } = renderHook(() => usePlanJob('runplan-aaaaaaaa-0123456789abcdef'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.data?.status).toBe('running'));
    await vi.advanceTimersByTimeAsync(20_000);
    await waitFor(() => expect(result.current.data).toEqual({ planId: 'p', status: 'done' }));
    const settled = spy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy.mock.calls.length).toBe(settled);
  });

  it('stops polling when unmounted', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.fn(async () => json({ data: { status: 'running' } }));
    vi.stubGlobal('fetch', spy);
    const { result, unmount } = renderHook(() => usePlanJob('runplan-aaaaaaaa-0123456789abcdef'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.data?.status).toBe('running'));
    unmount();
    const before = spy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy.mock.calls.length).toBe(before);
  });

  it('stops polling when the read fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.fn(async () =>
      json({ error: { code: 'RUN_PLAN_JOB_NOT_FOUND', message: 'nope' } }, 404)
    );
    vi.stubGlobal('fetch', spy);
    const { result } = renderHook(() => usePlanJob('runplan-aaaaaaaa-0123456789abcdef'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const before = spy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy.mock.calls.length).toBe(before);
  });
});
