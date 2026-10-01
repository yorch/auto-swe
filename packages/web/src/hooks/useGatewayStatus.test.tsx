// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGatewayStatus } from './useGatewayStatus';

afterEach(() => vi.unstubAllGlobals());

function run(fetchImpl: () => Promise<Response>) {
  const fetchSpy = vi.fn((_url: string) => fetchImpl());
  vi.stubGlobal('fetch', fetchSpy);
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { fetchSpy, ...renderHook(() => useGatewayStatus(), { wrapper }) };
}

describe('useGatewayStatus', () => {
  it('is pending until the first probe answers', () => {
    const { result } = run(() => new Promise(() => {}));
    expect(result.current).toBe('pending');
  });

  it.each([200, 429])('treats HTTP %i as online', async (status) => {
    const { result } = run(async () => new Response(null, { status }));
    await waitFor(() => expect(result.current).toBe('online'));
  });

  it.each([404, 500, 502, 503])('treats HTTP %i as offline', async (status) => {
    const { result } = run(async () => new Response(null, { status }));
    await waitFor(() => expect(result.current).toBe('offline'));
  });

  it('treats a network failure as offline', async () => {
    const { result } = run(async () => {
      throw new TypeError('Failed to fetch');
    });
    await waitFor(() => expect(result.current).toBe('offline'));
  });

  it('reports unknown, and logs, when the probe throws for a non-network reason', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = run(async () => {
      throw new TypeError('Invalid URL');
    });
    await waitFor(() => expect(result.current).toBe('unknown'));
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('probes the unauthenticated /health route', async () => {
    const { fetchSpy } = run(async () => new Response(null, { status: 200 }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(String(fetchSpy.mock.calls[0]?.[0])).toMatch(/\/health$/);
  });
});
