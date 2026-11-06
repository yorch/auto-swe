// @vitest-environment jsdom

import type { PullRequestCockpit, PullRequestCockpitDraft } from '@auto-swe/shared/types/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cockpitKey } from './usePullRequestCockpit';
import {
  useCreateDraft,
  useDeleteDraft,
  useEditDraft,
  useSendBack,
  useSubmitReview,
} from './useReviewActions';

const ID = '00000000-0000-4000-8000-0000000000aa';
const HEAD = 'b'.repeat(40);
const DIGEST = 'a'.repeat(64);

const draft = (over: Partial<PullRequestCockpitDraft> = {}): PullRequestCockpitDraft => ({
  body: 'use <=',
  createdAt: '2026-11-04T10:00:00.000Z',
  headSha: HEAD,
  id: 'd-1',
  line: 2,
  outdated: false,
  path: 'src/a.ts',
  ...over,
});

const cockpit = (drafts: PullRequestCockpitDraft[] = []): PullRequestCockpit => ({
  changedSinceViewed: [],
  drafts,
  evaluation: null,
  files: { reason: 'failed', type: 'unavailable' },
  pull: {
    ciStatus: 'PASSED',
    closedAt: null,
    costUsd: null,
    headSha: HEAD,
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
  sinceLastVisit: null,
  viewed: [],
  write: { approvalMayNotCount: false, available: true, feedbackLoopEnabled: true, reason: null },
});

type Call = { body: unknown; method: string; url: string };

/** A fake gateway: `reply` decides each call's answer from its method and path. */
function gateway(reply: (call: Call) => { body?: unknown; status?: number }) {
  const calls: Call[] = [];
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = (typeof input === 'string' ? input : input.toString()).replace(
      /^https?:\/\/[^/]+/,
      ''
    );
    const call = {
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      method: (init?.method ?? 'GET').toUpperCase(),
      url,
    };
    calls.push(call);
    const { body = {}, status = 200 } = reply(call);
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
      status,
    });
  });
  vi.stubGlobal('fetch', spy);
  return { calls, spy };
}

function setup(initial: PullRequestCockpit = cockpit()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(cockpitKey(ID), initial);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

const cached = (qc: QueryClient) => qc.getQueryData<PullRequestCockpit>(cockpitKey(ID));

afterEach(() => vi.unstubAllGlobals());

describe('useCreateDraft', () => {
  const input = { body: 'use <=', headSha: HEAD, line: 2, patchDigest: DIGEST, path: 'src/a.ts' };
  const stored = { ...draft(), outdated: undefined };

  it('sends the comment and adds what the gateway kept to the page, without a read', async () => {
    const g = gateway(() => ({ body: { data: stored }, status: 201 }));
    const { qc, wrapper } = setup();
    const { result } = renderHook(() => useCreateDraft(ID), { wrapper });
    await act(() => result.current.mutateAsync(input));
    expect(g.calls).toEqual([
      { body: input, method: 'POST', url: `/api/v1/pull-requests/${ID}/drafts` },
    ]);
    expect(cached(qc)?.drafts).toEqual([draft()]);
  });

  it('adds to the drafts already there', async () => {
    gateway(() => ({ body: { data: { ...stored, id: 'd-2', line: 5 } }, status: 201 }));
    const { qc, wrapper } = setup(cockpit([draft()]));
    const { result } = renderHook(() => useCreateDraft(ID), { wrapper });
    await act(() => result.current.mutateAsync(input));
    expect(cached(qc)?.drafts.map((d) => d.id)).toEqual(['d-1', 'd-2']);
  });

  it('keeps the page as it was when the gateway refuses', async () => {
    gateway(() => ({
      body: { error: { code: 'TOO_MANY_DRAFTS', message: 'Too many' } },
      status: 400,
    }));
    const { qc, wrapper } = setup(cockpit([draft()]));
    const { result } = renderHook(() => useCreateDraft(ID), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(input).catch(() => undefined);
    });
    expect(cached(qc)?.drafts).toEqual([draft()]);
    await waitFor(() => expect(result.current.error?.message).toBe('Too many'));
  });

  it('replaces a read that was already in flight, which may not have seen the draft', async () => {
    gateway(() => ({ body: { data: stored }, status: 201 }));
    const { qc, wrapper } = setup();
    const invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
    void qc.fetchQuery({ queryFn: () => new Promise(() => undefined), queryKey: cockpitKey(ID) });
    const { result } = renderHook(() => useCreateDraft(ID), { wrapper });
    await act(() => result.current.mutateAsync(input));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: cockpitKey(ID) });
  });

  it('does not read again when none was in flight', async () => {
    gateway(() => ({ body: { data: stored }, status: 201 }));
    const { qc, wrapper } = setup();
    const invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
    const { result } = renderHook(() => useCreateDraft(ID), { wrapper });
    await act(() => result.current.mutateAsync(input));
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('useEditDraft', () => {
  it('changes the text on the page and leaves what is outdated as it was', async () => {
    const g = gateway(() => ({
      body: { data: { ...draft({ body: 'better' }), outdated: undefined } },
    }));
    const { qc, wrapper } = setup(cockpit([draft({ outdated: true }), draft({ id: 'd-2' })]));
    const { result } = renderHook(() => useEditDraft(ID), { wrapper });
    await act(() => result.current.mutateAsync({ body: 'better', draftId: 'd-1' }));
    expect(g.calls[0]).toEqual({
      body: { body: 'better' },
      method: 'PATCH',
      url: `/api/v1/pull-requests/${ID}/drafts/d-1`,
    });
    expect(cached(qc)?.drafts).toEqual([
      draft({ body: 'better', outdated: true }),
      draft({ id: 'd-2' }),
    ]);
  });
});

describe('useDeleteDraft', () => {
  it('removes the draft from the page', async () => {
    const g = gateway(() => ({ body: { data: { deleted: true } } }));
    const { qc, wrapper } = setup(cockpit([draft(), draft({ id: 'd-2' })]));
    const { result } = renderHook(() => useDeleteDraft(ID), { wrapper });
    await act(() => result.current.mutateAsync('d-1'));
    expect(g.calls[0]).toMatchObject({
      method: 'DELETE',
      url: `/api/v1/pull-requests/${ID}/drafts/d-1`,
    });
    expect(cached(qc)?.drafts.map((d) => d.id)).toEqual(['d-2']);
  });

  it('treats a draft that is already gone as deleted', async () => {
    gateway(() => ({
      body: { error: { code: 'DRAFT_NOT_FOUND', message: 'Draft not found' } },
      status: 404,
    }));
    const { qc, wrapper } = setup(cockpit([draft()]));
    const { result } = renderHook(() => useDeleteDraft(ID), { wrapper });
    await act(() => result.current.mutateAsync('d-1'));
    expect(cached(qc)?.drafts).toEqual([]);
  });

  it('keeps the draft when the pull request itself is not found', async () => {
    gateway(() => ({
      body: { error: { code: 'PULL_REQUEST_NOT_FOUND', message: 'Pull request not found' } },
      status: 404,
    }));
    const { qc, wrapper } = setup(cockpit([draft()]));
    const { result } = renderHook(() => useDeleteDraft(ID), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('d-1').catch(() => undefined);
    });
    expect(cached(qc)?.drafts).toEqual([draft()]);
  });
});

describe('useSubmitReview', () => {
  const input = { body: 'Looks good', draftIds: ['d-1'], event: 'APPROVE' as const, headSha: HEAD };
  const sent = { comments: 1, draftsKept: false, event: 'APPROVE', reviewId: 9, url: null };

  it('sends the review and answers what was sent', async () => {
    const g = gateway(() => ({ body: { data: sent } }));
    const { qc, wrapper } = setup();
    vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
    const { result } = renderHook(() => useSubmitReview(ID), { wrapper });
    const answer = await act(() => result.current.mutateAsync(input));
    expect(answer).toEqual(sent);
    expect(g.calls[0]).toEqual({
      body: input,
      method: 'POST',
      url: `/api/v1/pull-requests/${ID}/review`,
    });
  });

  it('reads the page again once it succeeds, so what was sent leaves the drafts', async () => {
    gateway(() => ({ body: { data: sent } }));
    const { qc, wrapper } = setup();
    const invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
    const { result } = renderHook(() => useSubmitReview(ID), { wrapper });
    await act(() => result.current.mutateAsync(input));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: cockpitKey(ID) });
  });

  it('changes nothing on the page when it fails', async () => {
    gateway(() => ({
      body: { error: { code: 'STALE_HEAD', message: 'New commits since you opened the page.' } },
      status: 409,
    }));
    const { qc, wrapper } = setup(cockpit([draft()]));
    const invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
    const { result } = renderHook(() => useSubmitReview(ID), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(input).catch(() => undefined);
    });
    expect(cached(qc)?.drafts).toEqual([draft()]);
    expect(invalidate).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.error?.message).toContain('New commits'));
  });
});

describe('useSendBack', () => {
  it('sends the head and the note', async () => {
    const g = gateway(() => ({ body: { data: { commentId: 5, url: null } } }));
    const { wrapper } = setup();
    const { result } = renderHook(() => useSendBack(ID), { wrapper });
    await act(() => result.current.mutateAsync({ headSha: HEAD, note: 'Handle empty.' }));
    expect(g.calls[0]).toEqual({
      body: { headSha: HEAD, note: 'Handle empty.' },
      method: 'POST',
      url: `/api/v1/pull-requests/${ID}/send-back`,
    });
  });

  it('sends no note when it is blank', async () => {
    const g = gateway(() => ({ body: { data: { commentId: 5, url: null } } }));
    const { wrapper } = setup();
    const { result } = renderHook(() => useSendBack(ID), { wrapper });
    await act(() => result.current.mutateAsync({ headSha: HEAD, note: '   ' }));
    expect(g.calls[0]?.body).toEqual({ headSha: HEAD });
  });
});
