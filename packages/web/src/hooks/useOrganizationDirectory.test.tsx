// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { setupFetchMock } from '@/test/rtl-helpers';
import { useOrganizationDirectory } from './useAdmin';

afterEach(() => vi.unstubAllGlobals());

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function signInAs(role: 'ADMIN' | 'LEAD') {
  useAuthStore.setState({ user: { role } } as never);
}

describe('useOrganizationDirectory', () => {
  it('lists every organization for a platform admin, not just their memberships', async () => {
    signInAs('ADMIN');
    const fetchSpy = setupFetchMock({
      '/api/v1/platform/organizations/budget-alerts': () => ({
        data: [{ id: 'o1' }, { id: 'o2' }],
      }),
    });
    const { result } = renderHook(() => useOrganizationDirectory(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(fetchSpy.mock.calls.map(([u]) => String(u))).toEqual([
      expect.stringContaining('/organizations/budget-alerts'),
    ]);
  });

  it('lists only memberships for a non-admin', async () => {
    signInAs('LEAD');
    setupFetchMock({
      '/api/v1/platform/organizations': () => ({ data: [{ id: 'o1' }] }),
    });
    const { result } = renderHook(() => useOrganizationDirectory(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
  });
});
