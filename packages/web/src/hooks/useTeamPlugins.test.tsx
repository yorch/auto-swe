// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '@/test/rtl-helpers';
import { useDisableTeamPlugin, useEnableTeamPlugin, useTeamPlugins } from './useTeamPlugins';

afterEach(() => vi.unstubAllGlobals());

const wrap =
  (qc: QueryClient) =>
  ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('team plugin hooks', () => {
  it('lists the team plugins', async () => {
    setupFetchMock({
      'GET /api/v1/teams/t1/plugins': () => ({
        data: [
          {
            description: 'd',
            enabled: false,
            enabledAt: null,
            hooksEnabled: false,
            latestVersion: 1,
            name: 'kit',
          },
        ],
      }),
    });
    const { result } = renderHook(() => useTeamPlugins('t1'), { wrapper: wrap(client()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.name).toBe('kit');
  });

  it('PUTs to enable and DELETEs to disable, returning the stranded agents', async () => {
    const spy = setupFetchMock({
      'DELETE /api/v1/teams/t1/plugins/my%20kit': () => ({
        data: { enabled: false, name: 'my kit', strandedAgents: [{ key: 'a', version: 2 }] },
      }),
      'PUT /api/v1/teams/t1/plugins/my%20kit': () => ({
        data: { enabled: true, enabledAt: 'x', name: 'my kit' },
      }),
    });
    const qc = client();
    const on = renderHook(() => useEnableTeamPlugin('t1'), { wrapper: wrap(qc) });
    await act(async () => {
      await on.result.current.mutateAsync('my kit');
    });
    const off = renderHook(() => useDisableTeamPlugin('t1'), { wrapper: wrap(qc) });
    let out: unknown;
    await act(async () => {
      out = await off.result.current.mutateAsync('my kit');
    });
    expect(out).toEqual({
      enabled: false,
      name: 'my kit',
      strandedAgents: [{ key: 'a', version: 2 }],
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
