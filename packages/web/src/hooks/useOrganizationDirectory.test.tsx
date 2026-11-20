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

// The signed-in person and what the server says they hold: only a platform admin holds
// `platform.users.manage`, which is how the dashboard tells one.
function signInAs(who: 'admin' | 'member') {
  useAuthStore.setState({ user: { role: 'USER', sub: who } } as never);
}
const permissionsFor = (who: 'admin' | 'member') => ({
  organizations: [],
  platformCapabilities: who === 'admin' ? ['platform.users.manage'] : [],
  platformRole: '',
  teams: [],
});

describe('useOrganizationDirectory', () => {
  it('lists every organization for a platform admin, not just their memberships', async () => {
    signInAs('admin');
    const fetchSpy = setupFetchMock({
      '/api/v1/me/permissions': () => permissionsFor('admin'),
      '/api/v1/platform/organizations/budget-alerts': () => ({
        data: [{ id: 'o1' }, { id: 'o2' }],
      }),
    });
    const { result } = renderHook(() => useOrganizationDirectory(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    const urls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(urls).toContainEqual(expect.stringContaining('/organizations/budget-alerts'));
    expect(urls.some((u) => u.endsWith('/api/v1/platform/organizations'))).toBe(false);
  });

  it('lists only memberships for a non-admin', async () => {
    signInAs('member');
    setupFetchMock({
      '/api/v1/me/permissions': () => permissionsFor('member'),
      '/api/v1/platform/organizations': () => ({ data: [{ id: 'o1' }] }),
    });
    const { result } = renderHook(() => useOrganizationDirectory(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
  });
});
