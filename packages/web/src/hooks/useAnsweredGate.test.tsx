// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnsweredGate } from './useAnsweredGate';

const get = vi.fn();
vi.mock('@/lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a) } }));

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  get.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe('useAnsweredGate', () => {
  it('asks for one step the viewer answered, of any status', async () => {
    get.mockResolvedValue({ data: [], meta: { total: 0 } });
    const { result } = renderHook(() => useAnsweredGate(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith('/api/v1/human-steps?status=ALL&answeredByMe=true&limit=1');
    expect(result.current.data?.meta.total).toBe(0);
  });

  it('surfaces a failed request as an error', async () => {
    get.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useAnsweredGate(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
