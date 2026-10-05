// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '@/test/rtl-helpers';
import { useApprovals } from './useApprovals';

afterEach(() => vi.unstubAllGlobals());

function pollInterval(args: Parameters<typeof useApprovals>) {
  setupFetchMock({ '/api/v1/human-steps': () => ({ data: [] }) });
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useApprovals(...args), { wrapper });
  return waitFor(() => expect(result.current.isSuccess).toBe(true)).then(
    () => qc.getQueryCache().getAll()[0]?.observers[0]?.options.refetchInterval
  );
}

describe('useApprovals fallback poll', () => {
  it('polls pending steps', async () => {
    expect(await pollInterval(['PENDING'])).toBe(30_000);
  });

  it("polls one run's steps even when the status filter is ALL", async () => {
    expect(await pollInterval(['ALL', 'requestedAt:desc', false, 'run-1'])).toBe(30_000);
  });

  it('does not poll the unscoped history', async () => {
    expect(await pollInterval(['ALL'])).toBe(false);
  });
});
