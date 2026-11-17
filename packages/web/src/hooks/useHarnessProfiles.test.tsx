// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '@/test/rtl-helpers';
import { usePatchProfile } from './useHarnessProfiles';

afterEach(() => vi.unstubAllGlobals());

describe('usePatchProfile', () => {
  it('sends the expected version and invalidates every list a plugin change reaches', async () => {
    const calls: unknown[] = [];
    setupFetchMock({
      'PATCH /api/v1/platform/harness-profiles/kit': (body?: unknown) => {
        calls.push(body);
        return { data: {} };
      },
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => usePatchProfile(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ expectedVersion: 2, hooksEnabled: true, name: 'kit' });
    });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const keys = spy.mock.calls.map((c) => String((c[0]?.queryKey ?? [])[0]));
    expect(keys).toEqual(
      expect.arrayContaining([
        'harness-profiles',
        'skills',
        'admin-agent-library',
        'team-agent-library',
        'team-plugins',
        'marketplaces',
      ])
    );
    expect(JSON.stringify(calls[0])).toContain('"expectedVersion":2');
  });
});
