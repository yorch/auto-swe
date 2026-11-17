// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock } from '@/test/rtl-helpers';
import { useApproveEntry, useMarketplaces, usePreviewEntry } from './useMarketplaces';

afterEach(() => vi.unstubAllGlobals());

const wrap =
  (qc: QueryClient) =>
  ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('marketplace hooks', () => {
  it('lists marketplaces', async () => {
    setupFetchMock({ 'GET /api/v1/platform/marketplaces': () => ({ data: [{ id: 'm1' }] }) });
    const { result } = renderHook(() => useMarketplaces(), { wrapper: wrap(client()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ id: 'm1' }]);
  });

  it('previews an entry by name', async () => {
    const spy = setupFetchMock({
      'POST /api/v1/platform/marketplaces/m1/entries/preview': () => ({ data: { sha: 's' } }),
    });
    const { result } = renderHook(() => usePreviewEntry(), { wrapper: wrap(client()) });
    await act(async () => {
      await result.current.mutateAsync({ entry: 'kit', id: 'm1' });
    });
    expect(bodyOf(spy, '/api/v1/platform/marketplaces/m1/entries/preview')).toEqual({
      entry: 'kit',
    });
  });

  it('approves with the previewed hashes and an explicit hooksEnabled, never the id', async () => {
    const spy = setupFetchMock({
      'POST /api/v1/platform/marketplaces/m1/entries/approve': () => ({
        data: { commitSha: 's', hooksEnabled: false, id: 'p1', name: 'kit', version: 1 },
      }),
    });
    const { result } = renderHook(() => useApproveEntry(), { wrapper: wrap(client()) });
    let out: unknown;
    await act(async () => {
      out = await result.current.mutateAsync({
        acknowledgeWarnings: false,
        contentHash: 'c',
        entry: 'kit',
        hooksEnabled: false,
        id: 'm1',
        sha: 's',
        warningsHash: 'w',
      });
    });
    expect(bodyOf(spy, '/api/v1/platform/marketplaces/m1/entries/approve')).toEqual({
      acknowledgeWarnings: false,
      contentHash: 'c',
      entry: 'kit',
      hooksEnabled: false,
      sha: 's',
      warningsHash: 'w',
    });
    expect(out).toMatchObject({ name: 'kit', projection: null });
  });
});
