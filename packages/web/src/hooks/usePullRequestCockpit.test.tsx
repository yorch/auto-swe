// @vitest-environment jsdom

import type { PullRequestCockpit } from '@auto-swe/shared/types/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock } from '@/test/rtl-helpers';
import { cockpitKey, usePullRequestCockpit, useSetFilesViewed } from './usePullRequestCockpit';

const ID = '00000000-0000-4000-8000-0000000000aa';

const data = (viewed: string[] = []): PullRequestCockpit => ({
  evaluation: null,
  files: { reason: 'failed', type: 'unavailable' },
  pull: {
    ciStatus: 'PASSED',
    closedAt: null,
    costUsd: null,
    headSha: 'abc',
    id: ID,
    isDraft: false,
    latestRun: null,
    mergedAt: null,
    openedAt: '2026-11-01T09:00:00.000Z',
    prNumber: 7,
    repository: null,
    status: 'OPEN',
    ticketId: null,
    title: null,
    url: null,
    workRequestId: null,
  },
  viewed,
});

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

afterEach(() => vi.unstubAllGlobals());

describe('usePullRequestCockpit', () => {
  it('reads the cockpit of the pull request and polls slowly', async () => {
    const spy = setupFetchMock({
      [`/api/v1/pull-requests/${ID}/cockpit`]: () => ({ data: data() }),
    });
    const { qc, wrapper } = setup();
    const { result } = renderHook(() => usePullRequestCockpit(ID), { wrapper });
    await waitFor(() => expect(result.current.data?.pull.id).toBe(ID));
    expect(spy).toHaveBeenCalledTimes(1);
    const options = qc.getQueryCache().find({ queryKey: cockpitKey(ID) })?.observers[0]?.options;
    expect(options?.refetchInterval).toBe(30_000);
  });

  it('reads nothing without an id', () => {
    const spy = setupFetchMock({});
    const { wrapper } = setup();
    renderHook(() => usePullRequestCockpit(''), { wrapper });
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not retry a pull request that is not there', async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'PULL_REQUEST_NOT_FOUND', message: 'no' } }), {
          headers: { 'content-type': 'application/json' },
          status: 404,
        })
    );
    vi.stubGlobal('fetch', spy);
    const { wrapper } = setup();
    const { result } = renderHook(() => usePullRequestCockpit(ID), { wrapper });
    // The hook sets its own `retry`, which wins over the client's default; a retry would wait a
    // second before asking again, so the error appearing at all means there was none.
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('useSetFilesViewed', () => {
  const change = { files: [{ patchDigest: 'a'.repeat(64), path: 'src/a.ts' }], viewed: true };

  it('shows the mark at once and sends it', async () => {
    const spy = setupFetchMock({
      [`PUT /api/v1/pull-requests/${ID}/viewed`]: () => ({ data: { updated: 1 } }),
    });
    const { qc, wrapper } = setup();
    qc.setQueryData(cockpitKey(ID), data(['old.ts']));
    const { result } = renderHook(() => useSetFilesViewed(ID), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(change);
    });
    expect(qc.getQueryData<PullRequestCockpit>(cockpitKey(ID))?.viewed).toEqual([
      'old.ts',
      'src/a.ts',
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(bodyOf(spy, `/api/v1/pull-requests/${ID}/viewed`, 'PUT')).toEqual(change);
  });

  it('does not read the cockpit again after a success', async () => {
    const spy = setupFetchMock({
      [`PUT /api/v1/pull-requests/${ID}/viewed`]: () => ({ data: { updated: 1 } }),
    });
    const { qc, wrapper } = setup();
    qc.setQueryData(cockpitKey(ID), data());
    const { result } = renderHook(() => useSetFilesViewed(ID), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(change);
    });
    expect(
      spy.mock.calls.some(
        ([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET'
      )
    ).toBe(false);
  });

  it('puts the marks back when the gateway refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 'TOO_MANY_VIEWED_FILES', message: 'no' } }),
            {
              headers: { 'content-type': 'application/json' },
              status: 400,
            }
          )
      )
    );
    const { qc, wrapper } = setup();
    qc.setQueryData(cockpitKey(ID), data(['old.ts']));
    const { result } = renderHook(() => useSetFilesViewed(ID), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(change).catch(() => undefined);
    });
    expect(qc.getQueryData<PullRequestCockpit>(cockpitKey(ID))?.viewed).toEqual(['old.ts']);
  });

  it('clears a mark', async () => {
    setupFetchMock({
      [`PUT /api/v1/pull-requests/${ID}/viewed`]: () => ({ data: { updated: 1 } }),
    });
    const { qc, wrapper } = setup();
    qc.setQueryData(cockpitKey(ID), data(['src/a.ts', 'b.ts']));
    const { result } = renderHook(() => useSetFilesViewed(ID), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ ...change, viewed: false });
    });
    expect(qc.getQueryData<PullRequestCockpit>(cockpitKey(ID))?.viewed).toEqual(['b.ts']);
  });

  it('changes nothing in the cache when there is no cockpit loaded yet', async () => {
    setupFetchMock({
      [`PUT /api/v1/pull-requests/${ID}/viewed`]: () => ({ data: { updated: 1 } }),
    });
    const { qc, wrapper } = setup();
    const { result } = renderHook(() => useSetFilesViewed(ID), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(change);
    });
    expect(qc.getQueryData(cockpitKey(ID))).toBeUndefined();
  });
});
