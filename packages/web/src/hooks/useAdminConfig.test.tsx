// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '@/test/rtl-helpers';
import {
  testIssueTrackerConnection,
  testStorageConnection,
  triggerConsolidationNow,
  useCanaryConfig,
  useGitHubConfig,
  useGoogleOAuthConfig,
  useUpdateGitHubConfig,
} from './useAdminConfig';

afterEach(() => vi.unstubAllGlobals());

/**
 * Eleven config resources are generated from one slug apiece, so what the
 * factory has to get right is the mapping — path, cache key, and which of the
 * two GET shapes a resource unwraps. A wrong key is the dangerous failure: it
 * reads one resource's cache and invalidates another's, silently.
 */

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('sourcedConfigQuery', () => {
  it('GETs the slug path and returns { data, sources } whole', async () => {
    setupFetchMock({
      'GET /api/v1/platform/config/github': () => ({
        data: { token: { lastFour: 'abcd' } },
        sources: { token: 'db' },
      }),
    });

    const { result } = renderHook(() => useGitHubConfig(), { wrapper: wrapper(client()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      data: { token: { lastFour: 'abcd' } },
      sources: { token: 'db' },
    });
  });

  it('flattens a nested slug into the cache key', async () => {
    setupFetchMock({
      'GET /api/v1/platform/config/oauth/google': () => ({ data: { clientId: 'x' }, sources: {} }),
    });
    const qc = client();

    const { result } = renderHook(() => useGoogleOAuthConfig(), { wrapper: wrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(qc.getQueryData(['admin-config-oauth-google'])).toBeTruthy();
  });
});

describe('unwrappedConfigQuery', () => {
  it('strips the data envelope for the configs that carry no source badges', async () => {
    setupFetchMock({
      'GET /api/v1/platform/config/canary': () => ({ data: { percent: 10 } }),
    });

    const { result } = renderHook(() => useCanaryConfig(), { wrapper: wrapper(client()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ percent: 10 });
  });
});

describe('configMutation', () => {
  it('PUTs the body to the slug path and invalidates that slug only', async () => {
    const spy = setupFetchMock({
      'GET /api/v1/platform/config/github': () => ({ data: { token: null }, sources: {} }),
      'PUT /api/v1/platform/config/github': () => ({ data: { token: { lastFour: 'wxyz' } } }),
    });
    const qc = client();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateGitHubConfig(), { wrapper: wrapper(qc) });
    await result.current.mutateAsync({ token: 'ghp_secret' });

    const put = spy.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PUT');
    if (!put) {
      throw new Error('expected a PUT');
    }
    expect(put[0]).toContain('/api/v1/platform/config/github');
    expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({ token: 'ghp_secret' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin-config-github'] });
  });
});

describe('postConfigTest / postConfigTrigger', () => {
  it('POSTs an empty body when the connector needs no probe input', async () => {
    const spy = setupFetchMock({
      'POST /api/v1/platform/config/storage/test': () => ({ detail: 'ok', ok: true }),
    });

    await expect(testStorageConnection()).resolves.toEqual({ detail: 'ok', ok: true });
    expect(JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string)).toEqual({});
  });

  it('POSTs the probe input for the connectors that take one', async () => {
    const spy = setupFetchMock({
      'POST /api/v1/platform/config/issue-tracker/test': () => ({ detail: 'found', ok: true }),
    });

    await testIssueTrackerConnection('JIRA-1');

    expect(JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      ticketId: 'JIRA-1',
    });
  });

  it('POSTs the trigger path for a scheduled config', async () => {
    const spy = setupFetchMock({
      'POST /api/v1/platform/config/consolidation/trigger': () => ({ data: { triggered: true } }),
    });

    await expect(triggerConsolidationNow()).resolves.toEqual({ data: { triggered: true } });
    expect(spy.mock.calls[0][0]).toContain('/api/v1/platform/config/consolidation/trigger');
  });
});
