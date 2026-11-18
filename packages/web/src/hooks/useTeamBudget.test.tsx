// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '@/test/rtl-helpers';
import { useUpdateTeamBudget } from './useTeamBudget';

afterEach(() => vi.unstubAllGlobals());

describe('useUpdateTeamBudget', () => {
  it('refreshes the pending budget requests so a saved cap clears them', async () => {
    setupFetchMock({
      'PATCH /api/v1/teams/t-1/budget': () => ({ data: { monthlyBudgetUsdCents: 1000 } }),
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useUpdateTeamBudget('t-1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ monthlyBudgetUsdCents: 1000 });
    });
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(['team-budget-requests', 't-1']);
    expect(keys).toContainEqual(['team-budget', 't-1']);
  });
});
