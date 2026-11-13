// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock } from '@/test/rtl-helpers';
import {
  useDeleteTeamSecret,
  useSaveTeamSecret,
  useSetTeamSecretGrants,
  useTeamSecrets,
} from './useTeamSecrets';

afterEach(() => vi.unstubAllGlobals());

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('team secret hooks', () => {
  it('lists the team secrets from the team route', async () => {
    setupFetchMock({
      'GET /api/v1/teams/t-1/secrets': () => ({
        data: [{ grantedConnectionIds: [], lastFour: 'cdef', name: 'A_TOKEN', updatedAt: 'x' }],
      }),
    });
    const { result } = renderHook(() => useTeamSecrets('t-1'), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.name).toBe('A_TOKEN');
  });

  it('PUTs only the value to the named secret', async () => {
    const qc = newClient();
    const spy = setupFetchMock({
      'PUT /api/v1/teams/t-1/secrets/NPM_TOKEN': () => ({ data: {} }),
    });
    const { result } = renderHook(() => useSaveTeamSecret('t-1'), { wrapper: wrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ name: 'NPM_TOKEN', value: 'supersecret-value' });
    });
    expect(bodyOf(spy, '/api/v1/teams/t-1/secrets/NPM_TOKEN', 'PUT')).toEqual({
      value: 'supersecret-value',
    });
  });

  it('DELETEs the named secret', async () => {
    const spy = setupFetchMock({
      'DELETE /api/v1/teams/t-1/secrets/NPM_TOKEN': () => ({ data: null }),
    });
    const { result } = renderHook(() => useDeleteTeamSecret('t-1'), {
      wrapper: wrapper(newClient()),
    });
    await act(async () => {
      await result.current.mutateAsync('NPM_TOKEN');
    });
    const call = spy.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'DELETE');
    expect(String(call?.[0])).toContain('/api/v1/teams/t-1/secrets/NPM_TOKEN');
  });

  it('PUTs the replacement grant set to the grants route', async () => {
    const spy = setupFetchMock({
      'PUT /api/v1/teams/t-1/secrets/NPM_TOKEN/grants': () => ({ data: {} }),
    });
    const { result } = renderHook(() => useSetTeamSecretGrants('t-1'), {
      wrapper: wrapper(newClient()),
    });
    await act(async () => {
      await result.current.mutateAsync({ connectionIds: ['c-1', 'c-2'], name: 'NPM_TOKEN' });
    });
    expect(bodyOf(spy, '/api/v1/teams/t-1/secrets/NPM_TOKEN/grants', 'PUT')).toEqual({
      connectionIds: ['c-1', 'c-2'],
    });
  });
});
