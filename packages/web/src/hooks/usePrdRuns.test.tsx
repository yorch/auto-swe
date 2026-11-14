// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { useCreatePrdRun } from './usePrdRuns';

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
  prdContent: 'Let teams invite people.',
  prdTitle: 'Invitations',
  repoIds: ['11111111-1111-4111-8111-111111111111'],
};
const CREATED = { data: { prdWorkflowId: 'prd-invitations-1a2b3c4d', workRequestId: 'wr-1' } };

describe('useCreatePrdRun', () => {
  it('keeps the Idempotency-Key for a retried launch and rotates it for a changed one', async () => {
    const fetch = vi
      .spyOn(api, 'fetch')
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce(CREATED)
      .mockResolvedValueOnce(CREATED);
    const { result } = renderHook(() => useCreatePrdRun(), { wrapper: wrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(BODY)).rejects.toThrow();
    });
    await act(async () => {
      await result.current.mutateAsync(BODY);
    });
    await act(async () => {
      await result.current.mutateAsync({ ...BODY, prdTitle: 'Another' });
    });
    const keys = fetch.mock.calls.map(
      (c) => ((c[1]?.headers ?? {}) as Record<string, string>)['Idempotency-Key']
    );
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/prd-runs');
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual(BODY);
  });
});
