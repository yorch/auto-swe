// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { setupFetchMock } from '@/test/rtl-helpers';
import {
  useReviewAttachment,
  useReviewChoices,
  useReviewPresets,
  useReviewRepositories,
  useRunReview,
  useSaveReviewPreset,
} from './useCodeReview';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}
describe('review mutations', () => {
  it('binds picker caches and management requests to the selected source/team', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ data: [], templates: [] });
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} });
    const { result } = renderHook(
      () => ({
        choices: useReviewChoices(true, { sourceRunId: 'source' }),
        presets: useReviewPresets('team'),
        save: useSaveReviewPreset('team'),
      }),
      { wrapper: wrapper() }
    );
    await waitFor(() =>
      expect(result.current.choices.isSuccess && result.current.presets.isSuccess).toBe(true)
    );
    expect(get).toHaveBeenCalledWith('/api/v1/review-presets?sourceRunId=source');
    expect(get).toHaveBeenCalledWith('/api/v1/platform/review-presets?teamId=team');
    await act(async () => {
      await result.current.save.mutateAsync({ body: { name: 'Review', templateId: 'template' } });
    });
    expect(post).toHaveBeenCalledWith(
      '/api/v1/platform/review-presets?teamId=team',
      expect.objectContaining({ name: 'Review' })
    );
  });
  it('keeps the same idempotency key after a failed launch and rotates it for a changed choice', async () => {
    const fetch = vi
      .spyOn(api, 'fetch')
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue({ data: { runId: 'review-1', workflowId: 'workflow-1' } });
    const { result } = renderHook(() => useRunReview('source-1'), { wrapper: wrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync({ presetId: 'preset-1' })).rejects.toThrow();
    });
    await act(async () => {
      await expect(result.current.mutateAsync({ presetId: 'preset-1' })).rejects.toThrow();
    });
    await act(async () => {
      await result.current.mutateAsync({ templateId: 'template-1' });
    });
    const headers = fetch.mock.calls.map((c) => c[1]?.headers as Record<string, string>);
    expect(headers[0]?.['Idempotency-Key']).toBeTruthy();
    expect(headers[0]).toEqual(headers[1]);
    expect(headers[2]).not.toEqual(headers[1]);
    expect(fetch.mock.calls[2]?.[0]).toBe('/api/v1/workflow-runs/source-1/reviews');
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({
      templateId: 'template-1',
    });
    await waitFor(() => expect(result.current.data?.runId).toBe('review-1'));
  });
  it.each([{ templateId: 'template-1' }, { connectionId: 'repo-1' }])(
    'sends the attachment target on both POST and DELETE',
    async (target) => {
      const fetch = setupFetchMock({
        '/api/v1/platform/review-presets/preset-1/attachments': () => ({ data: {} }),
      });
      const { result } = renderHook(useReviewAttachment, { wrapper: wrapper() });
      await act(async () => {
        await result.current.mutateAsync({ id: 'preset-1', target });
      });
      await act(async () => {
        await result.current.mutateAsync({ id: 'preset-1', remove: true, target });
      });
      expect(fetch.mock.calls.map((c) => c[1]?.method)).toEqual(['POST', 'DELETE']);
      expect(fetch.mock.calls.map((c) => JSON.parse(String(c[1]?.body)))).toEqual([target, target]);
    }
  );
  it('reads every repository page and excludes non-git connections', async () => {
    const fetch = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({
        data: [
          { id: 'repo-1', type: 'git_repo' },
          { id: 'api-1', type: 'api_endpoint' },
        ],
        meta: { total: 3 },
      })
      .mockResolvedValueOnce({ data: [{ id: 'repo-2', type: 'git_repo' }], meta: { total: 3 } });
    const { result } = renderHook(useReviewRepositories, { wrapper: wrapper() });
    await waitFor(() =>
      expect(result.current.data?.map((r) => r.id)).toEqual(['repo-1', 'repo-2'])
    );
    expect(fetch.mock.calls[1]?.[0]).toContain('offset=2');
  });
});
