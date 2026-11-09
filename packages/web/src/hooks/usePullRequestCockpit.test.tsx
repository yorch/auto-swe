// @vitest-environment jsdom

import type { PullRequestCockpit } from '@auto-swe/shared/types/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock } from '@/test/rtl-helpers';
import {
  COCKPIT_POLL_MS,
  cockpitKey,
  cockpitRefetchInterval,
  usePullRequestCockpit,
  useSetFilesViewed,
} from './usePullRequestCockpit';

const ID = '00000000-0000-4000-8000-0000000000aa';

const data = (viewed: string[] = []): PullRequestCockpit => ({
  changedSinceViewed: [],
  drafts: [],
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
    ownerTeam: null,
    prNumber: 7,
    repository: null,
    status: 'OPEN',
    ticketId: null,
    title: null,
    url: null,
    workRequestId: null,
  },
  sinceLastVisit: null,
  viewed,
  write: {
    approvalMayNotCount: false,
    available: false,
    feedbackLoopEnabled: false,
    reason: 'no-token',
  },
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
    expect(typeof options?.refetchInterval).toBe('function');
  });

  describe('the polling interval', () => {
    const withState = (state: string): PullRequestCockpit => ({
      ...data(),
      files: { headSha: 'abc', items: [], state, truncated: false, type: 'ok' },
    });

    it('is a minute while the pull request is open, and before anything has loaded', () => {
      expect(cockpitRefetchInterval(withState('open'))).toBe(COCKPIT_POLL_MS);
      expect(cockpitRefetchInterval(undefined)).toBe(COCKPIT_POLL_MS);
      expect(COCKPIT_POLL_MS).toBe(60_000);
    });

    it('stops once the host reports the pull request closed', () => {
      expect(cockpitRefetchInterval(withState('closed'))).toBe(false);
    });

    it('keeps polling while the files cannot be read, since the state is then unknown', () => {
      expect(cockpitRefetchInterval(data())).toBe(COCKPIT_POLL_MS);
    });
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

  describe('two changes in flight', () => {
    const mark = (path: string) => ({
      files: [{ patchDigest: 'a'.repeat(64), path }],
      viewed: true,
    });
    const okReply = () =>
      new Response(JSON.stringify({ data: { updated: 1 } }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    const refused = () =>
      new Response(JSON.stringify({ error: { code: 'TOO_MANY_VIEWED_FILES', message: 'no' } }), {
        headers: { 'content-type': 'application/json' },
        status: 400,
      });

    it('keeps a later change that succeeded when an earlier one fails', async () => {
      let failFirst: (reply: Response) => void = () => undefined;
      const first = new Promise<Response>((resolve) => {
        failFirst = resolve;
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: unknown, init?: RequestInit) =>
          String(init?.body).includes('x.ts') ? first : okReply()
        )
      );
      const { qc, wrapper } = setup();
      qc.setQueryData(cockpitKey(ID), data());
      const { result } = renderHook(() => useSetFilesViewed(ID), { wrapper });

      let firstDone: Promise<unknown> = Promise.resolve();
      await act(async () => {
        firstDone = result.current.mutateAsync(mark('x.ts')).catch(() => undefined);
        await result.current.mutateAsync(mark('y.ts'));
      });
      expect(qc.getQueryData<PullRequestCockpit>(cockpitKey(ID))?.viewed).toEqual(['x.ts', 'y.ts']);

      await act(async () => {
        failFirst(refused());
        await firstDone;
      });
      // A snapshot taken before either change would have restored the empty list and lost y.ts.
      expect(qc.getQueryData<PullRequestCockpit>(cockpitKey(ID))?.viewed).toEqual(['y.ts']);
    });
  });

  describe('a read in flight when a change settles', () => {
    const okReply = () =>
      new Response(JSON.stringify({ data: { updated: 1 } }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    const cockpitReply = () =>
      new Response(JSON.stringify({ data: data() }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    const change = { files: [{ patchDigest: 'a'.repeat(64), path: 'src/a.ts' }], viewed: true };

    it('is replaced by a fresh read, since it may predate the change', async () => {
      let finishPut: (reply: Response) => void = () => undefined;
      const put = new Promise<Response>((resolve) => {
        finishPut = resolve;
      });
      let putAsked: () => void = () => undefined;
      const putWasSent = new Promise<void>((resolve) => {
        putAsked = resolve;
      });
      let cockpitReads = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: unknown, init?: RequestInit) => {
          if (init?.method === 'PUT') {
            putAsked();
            return put;
          }
          cockpitReads += 1;
          // The first read answers; a poll started while the change is pending never does.
          return cockpitReads === 1 ? cockpitReply() : new Promise<Response>(() => undefined);
        })
      );
      const { qc, wrapper } = setup();
      const invalidate = vi.spyOn(qc, 'invalidateQueries');
      const { result } = renderHook(
        () => ({ mark: useSetFilesViewed(ID), page: usePullRequestCockpit(ID) }),
        { wrapper }
      );
      await waitFor(() => expect(result.current.page.data).toBeDefined());

      act(() => result.current.mark.mutate(change));
      // Once the change is on the wire its own start-up (which cancels reads) is over, so a read
      // begun now is one that could have been answered before the change was stored.
      await putWasSent;
      act(() => void result.current.page.refetch());
      await waitFor(() => expect(result.current.page.isFetching).toBe(true));

      await act(async () => {
        finishPut(okReply());
      });
      await waitFor(() => expect(result.current.mark.isSuccess).toBe(true));
      expect(invalidate).toHaveBeenCalledWith({ queryKey: cockpitKey(ID) });
    });

    it('is not needed, and not made, when nothing was being read', async () => {
      setupFetchMock({
        [`/api/v1/pull-requests/${ID}/cockpit`]: () => ({ data: data() }),
        [`PUT /api/v1/pull-requests/${ID}/viewed`]: () => ({ data: { updated: 1 } }),
      });
      const { qc, wrapper } = setup();
      const invalidate = vi.spyOn(qc, 'invalidateQueries');
      const { result } = renderHook(
        () => ({ mark: useSetFilesViewed(ID), page: usePullRequestCockpit(ID) }),
        { wrapper }
      );
      await waitFor(() => expect(result.current.page.data).toBeDefined());
      await act(async () => {
        await result.current.mark.mutateAsync(change);
      });
      expect(invalidate).not.toHaveBeenCalled();
    });
  });
});
