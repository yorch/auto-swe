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
  useCreateCampaign,
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
    expect(['STARTING', 'RUNNING', 'CANCELLING'].some(isCampaignTerminal)).toBe(false);
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
});
