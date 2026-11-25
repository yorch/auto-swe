// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '@/lib/api';
import {
  isCampaignNotFound,
  isCampaignTerminal,
  useCampaign,
  useCampaigns,
  useCancelCampaign,
  useConfirmCampaign,
  useCreateCampaign,
  usePauseCampaign,
  useRemoveCampaignTarget,
  useResumeCampaign,
  useRetryCampaignTarget,
  useTakeOverCampaign,
} from './useCampaigns';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const BODY = {
  description: 'Raise lodash',
  name: 'Lodash',
  ownerTeamId: 'team-1',
  repoIds: ['repo-1'],
};
const CREATED = {
  data: {
    campaignId: 'c1',
    detailPath: '/campaigns/c1',
    targetCount: 1,
    temporalWorkflowId: 'campaign-c1',
    workRequestId: 'wr1',
  },
};

describe('campaign states', () => {
  it('treats only the final states as terminal', () => {
    expect(
      ['STARTING', 'PLANNING', 'ACTIVE', 'PAUSED', 'MONITORING', 'RUNNING', 'CANCELLING'].some(
        isCampaignTerminal
      )
    ).toBe(false);
    expect(
      ['COMPLETED', 'COMPLETED_WITH_FAILURES', 'CANCELLED', 'FAILED_TO_START'].every(
        isCampaignTerminal
      )
    ).toBe(true);
  });

  it('recognises the gateway’s not-found answer', () => {
    expect(isCampaignNotFound(new ApiError('nope', 404, 'CAMPAIGN_NOT_FOUND'))).toBe(true);
    expect(isCampaignNotFound(new ApiError('boom', 500, null))).toBe(false);
    expect(isCampaignNotFound(new Error('x'))).toBe(false);
  });
});

describe('campaign queries', () => {
  it('lists one page, filtered by state and owning team', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({
      data: [],
      meta: { limit: 30, offset: 30, total: 0 },
    });
    const { result } = renderHook(
      () => useCampaigns({ limit: 30, offset: 30, state: 'RUNNING' }, { teamId: 'team-1' }),
      { wrapper: wrapper() }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith(
      '/api/v1/campaigns?limit=30&offset=30&state=RUNNING&ownerTeamId=team-1'
    );
  });

  it('filters by kind', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({
      data: [],
      meta: { limit: 30, offset: 0, total: 0 },
    });
    const { result } = renderHook(() => useCampaigns({ plan: 'PLANNED' }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith('/api/v1/campaigns?limit=50&offset=0&plan=PLANNED');
  });

  it('refreshes every ten seconds while any listed campaign is not final, and stops when all are', async () => {
    const page = (states: string[]) => ({
      data: states.map((state, i) => ({ id: `c${i}`, state })),
      meta: { limit: 50, offset: 0, total: states.length },
    });
    const intervalFor = async (states: string[]) => {
      vi.spyOn(api, 'get').mockResolvedValue(page(states));
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { result } = renderHook(() => useCampaigns(), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={qc}>{children}</QueryClientProvider>
        ),
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const query = qc.getQueryCache().getAll()[0];
      const option = (query?.options as { refetchInterval?: unknown } | undefined)?.refetchInterval;
      return typeof option === 'function' ? option(query) : option;
    };
    expect(await intervalFor(['COMPLETED', 'MONITORING'])).toBe(10_000);
    expect(await intervalFor(['COMPLETED', 'CANCELLED', 'COMPLETED_WITH_FAILURES'])).toBe(false);
    expect(await intervalFor(['FAILED_TO_START', 'PAUSED'])).toBe(10_000);
  });

  it('reads one campaign by id', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ data: { id: 'c 1', state: 'COMPLETED' } });
    const { result } = renderHook(() => useCampaign('c 1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.state).toBe('COMPLETED'));
    expect(get).toHaveBeenCalledWith('/api/v1/campaigns/c%201');
  });
});

describe('campaign mutations', () => {
  it('keeps the Idempotency-Key for a retried launch and rotates it for a changed one', async () => {
    const fetch = vi
      .spyOn(api, 'fetch')
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce(CREATED)
      .mockResolvedValueOnce(CREATED);
    const { result } = renderHook(() => useCreateCampaign(), { wrapper: wrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(BODY)).rejects.toThrow();
    });
    await act(async () => {
      await result.current.mutateAsync(BODY);
    });
    await act(async () => {
      await result.current.mutateAsync(BODY);
    });
    const keys = fetch.mock.calls.map(
      (c) => ((c[1]?.headers ?? {}) as Record<string, string>)['Idempotency-Key']
    );
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    // The first success cleared the remembered request, so the next launch is a new one.
    expect(keys[2]).not.toBe(keys[0]);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/campaigns');
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('POST');
  });

  it('posts the cancel to the campaign', async () => {
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValue({ data: { campaignId: 'c1', state: 'CANCELLING' } });
    const { result } = renderHook(() => useCancelCampaign('c1'), { wrapper: wrapper() });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(post).toHaveBeenCalledWith('/api/v1/campaigns/c1/cancel', {});
  });

  it('posts each campaign action to its own route', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { id: 'c1', state: 'ACTIVE' } });
    const hooks = [
      ['confirm', useConfirmCampaign],
      ['pause', usePauseCampaign],
      ['resume', useResumeCampaign],
      ['takeover', useTakeOverCampaign],
    ] as const;
    for (const [route, useAction] of hooks) {
      const { result } = renderHook(() => useAction('c 1'), { wrapper: wrapper() });
      await act(async () => {
        await result.current.mutateAsync();
      });
      expect(post).toHaveBeenLastCalledWith(`/api/v1/campaigns/c%201/${route}`, {});
    }
  });

  it('retries and removes one target by id', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { id: 't1', state: 'PENDING' } });
    const del = vi.spyOn(api, 'delete').mockResolvedValue({ data: { id: 't1', state: 'SKIPPED' } });
    const retry = renderHook(() => useRetryCampaignTarget('c1'), { wrapper: wrapper() });
    await act(async () => {
      await retry.result.current.mutateAsync('t 1');
    });
    expect(post).toHaveBeenCalledWith('/api/v1/campaigns/c1/targets/t%201/retry', {});
    const remove = renderHook(() => useRemoveCampaignTarget('c1'), { wrapper: wrapper() });
    await act(async () => {
      await remove.result.current.mutateAsync('t1');
    });
    expect(del).toHaveBeenCalledWith('/api/v1/campaigns/c1/targets/t1');
  });

  it('refreshes the campaign and the list after an action', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ data: { id: 'c1', state: 'PAUSED' } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => usePauseCampaign('c1'), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['campaign', 'c1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['campaigns'] });
  });

  it('shows a refusal from the gateway to the caller', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(
      new ApiError('Only a lead may take over', 403, 'FORBIDDEN')
    );
    const { result } = renderHook(() => useTakeOverCampaign('c1'), { wrapper: wrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow('Only a lead may take over');
    });
  });
});
