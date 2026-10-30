// @vitest-environment jsdom
import type { RunActivityItem } from '@auto-swe/shared/types/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportRunActivity, mergeActivity, useRunActivity } from './useRunActivity';

const get = vi.hoisted(() => vi.fn());
const download = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api: { download, get } }));
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('activity hooks', () => {
  it('merges overlapping inclusive polls by ID and sorts chronologically', () => {
    const item = (id: string, ts: string) => ({ id, ts }) as RunActivityItem;
    expect(
      mergeActivity([item('b', '2'), item('a', '1')], [item('b', '2')]).map((row) => row.id)
    ).toEqual(['a', 'b']);
  });
  it('polls with since only while live', async () => {
    get.mockResolvedValue({ data: [], nextCursor: null });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { rerender, unmount } = renderHook(({ live }) => useRunActivity('run', {}, live), {
      initialProps: { live: true },
      wrapper,
    });
    await waitFor(() => expect(get.mock.calls.some(([url]) => url.includes('since='))).toBe(true));
    const beforeStop = get.mock.calls.length;
    rerender({ live: false });
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(beforeStop));
    expect(
      qc
        .getQueryCache()
        .find({ queryKey: ['run-activity-live', 'run', {}] })
        ?.isActive()
    ).toBe(false);
    unmount();
    qc.clear();
  });
  it('rejects an incomplete NDJSON export', async () => {
    download.mockResolvedValue(await new Response('{"kind":"http_call"}\n').blob());
    await expect(exportRunActivity('run', {})).rejects.toThrow('incomplete');
  });
  it('downloads a complete export with the current filters', async () => {
    download.mockResolvedValue(await new Response('{"kind":"eof","complete":true}\n').blob());
    const revoke = vi.fn();
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:activity'),
      revokeObjectURL: revoke,
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await exportRunActivity('run', { kinds: 'http_call', specNodeId: 'node' });
    expect(download).toHaveBeenCalledWith(
      '/api/v1/workflow-runs/run/activity/export?kinds=http_call&specNodeId=node'
    );
    expect(click).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith('blob:activity');
  });
});
