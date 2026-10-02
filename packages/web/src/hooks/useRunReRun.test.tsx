// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRunReRun } from './useRunReRun';

afterEach(() => vi.unstubAllGlobals());

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

interface Call {
  headers: Record<string, string>;
  method: string;
  path: string;
}

function stubFetch(respond: (path: string) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = input.toString().replace(/^https?:\/\/[^/]+/, '');
      calls.push({
        headers: (init?.headers ?? {}) as Record<string, string>,
        method: init?.method ?? 'GET',
        path,
      });
      return respond(path);
    })
  );
  return calls;
}

const ok = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });

const WORK_REQUEST = { description: 'd', externalTicketId: 'agent-1', id: 'wr-1' };

function agentRun(deliver: string | null, via: 'payload' | 'result' = 'payload') {
  return {
    contextSnapshot: via === 'payload' && deliver ? { request: { payload: { deliver } } } : null,
    isAgentRun: true,
    result: via === 'result' && deliver ? { deliver } : null,
    workRequest: WORK_REQUEST,
  };
}

describe('useRunReRun', () => {
  it('re-runs an ordinary run through the generic retry, one click', async () => {
    const calls = stubFetch(() => ok({ temporalWorkflowId: 'w2', workRequestId: 'wr-2' }));
    const { result } = renderHook(
      () => useRunReRun({ ...agentRun('draft_pr'), isAgentRun: false }),
      { wrapper: wrapper() }
    );
    act(() => result.current.request());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.path).toBe('/api/v1/work-requests/wr-1/retry');
    expect(result.current.confirming).toBe(false);
  });

  it('re-runs a deliver:none agent run through the agent endpoint with a fresh key, one click', async () => {
    const calls = stubFetch(() =>
      ok({ data: { temporalWorkflowId: 'w2', workRequestId: 'wr-2' } })
    );
    const { result } = renderHook(() => useRunReRun(agentRun('none')), { wrapper: wrapper() });
    act(() => result.current.request());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.path).toBe('/api/v1/agent-runs/wr-1/rerun');
    expect(calls[0]?.headers['Idempotency-Key']).toMatch(/\S{16,}/);
    expect(calls.some((c) => c.path.includes('/work-requests/'))).toBe(false);
  });

  it.each([
    ['branch', /new branch/],
    ['draft_pr', /draft pull request/],
  ] as const)(
    'asks before re-running a %s agent run, naming what it creates',
    async (deliver, text) => {
      const calls = stubFetch(() =>
        ok({ data: { temporalWorkflowId: 'w2', workRequestId: 'wr-2' } })
      );
      const { result } = renderHook(() => useRunReRun(agentRun(deliver)), { wrapper: wrapper() });
      act(() => result.current.request());
      expect(result.current.confirming).toBe(true);
      expect(result.current.confirmMessage).toMatch(text);
      expect(calls).toHaveLength(0);

      act(() => result.current.cancel());
      expect(result.current.confirming).toBe(false);
      expect(calls).toHaveLength(0);

      act(() => result.current.request());
      act(() => result.current.confirm());
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]?.path).toBe('/api/v1/agent-runs/wr-1/rerun');
    }
  );

  it('asks when the delivery is not recorded, and reads it from the result when the payload is gone', () => {
    stubFetch(() => ok({}));
    const unknown = renderHook(() => useRunReRun(agentRun(null)), { wrapper: wrapper() });
    act(() => unknown.result.current.request());
    expect(unknown.result.current.confirming).toBe(true);

    const fromResult = renderHook(() => useRunReRun(agentRun('none', 'result')), {
      wrapper: wrapper(),
    });
    act(() => fromResult.result.current.request());
    expect(fromResult.result.current.confirming).toBe(false);
  });

  it('explains a re-run failure by its code', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: { code: 'AGENT_PIN_SHADOWED', message: 'shadowed by an override' },
          }),
          { headers: { 'content-type': 'application/json' }, status: 400 }
        )
    );
    const { result } = renderHook(() => useRunReRun(agentRun('none')), { wrapper: wrapper() });
    act(() => result.current.request());
    await waitFor(() => expect(result.current.errorView).not.toBeNull());
    expect(result.current.errorView).toMatchObject({
      message: 'shadowed by an override',
      title: 'That version cannot be pinned',
    });
  });

  it('locks after a started re-run so a second click cannot launch another', async () => {
    const calls = stubFetch(() =>
      ok({ data: { temporalWorkflowId: 'w2', workRequestId: 'wr-2' } })
    );
    const { result } = renderHook(() => useRunReRun(agentRun('none')), { wrapper: wrapper() });
    act(() => result.current.request());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    act(() => result.current.request());
    expect(calls).toHaveLength(1);
  });
});
