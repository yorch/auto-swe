// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: h }));

import {
  useDismissOnboardingChecklist,
  useOnboardingPrStatus,
  useOnboardingToolCatalog,
  useOpenOnboardingPr,
} from './useRepositoryOnboarding';

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  qc = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  h.get.mockReset();
  h.post.mockReset();
});
afterEach(() => {
  cleanup();
  qc.clear();
});
describe('repository onboarding hooks', () => {
  it('filters revoked tool versions and deduplicates keys', async () => {
    h.get.mockResolvedValue({
      data: [
        { key: 'jq', status: 'REVOKED' },
        { key: 'uv', status: 'ACTIVE' },
        { key: 'uv', status: 'DEPRECATED' },
      ],
    });
    const { result } = renderHook(() => useOnboardingToolCatalog(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(['uv']));
    expect(h.get).toHaveBeenCalledWith('/api/v1/platform/tool-catalog');
  });
  it('submits to the repository onboarding endpoint', async () => {
    h.post.mockResolvedValue({ data: { workflowId: 'workflow' } });
    const { result } = renderHook(() => useOpenOnboardingPr('repo'), { wrapper });
    expect(await result.current.mutateAsync({ files: [{ kind: 'prPolicy' }] })).toEqual({
      workflowId: 'workflow',
    });
    expect(h.post).toHaveBeenCalledWith('/api/v1/repositories/repo/onboarding-pr', {
      files: [{ kind: 'prPolicy' }],
    });
  });
  it('polls a running workflow and invalidates repositories on completion', async () => {
    h.get.mockResolvedValueOnce({ data: { status: 'running' } }).mockResolvedValue({
      data: {
        result: { changed: [], skipped: [], status: 'nothing_to_do' },
        status: 'completed',
      },
    });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useOnboardingPrStatus('repo', 'workflow'), { wrapper });
    await waitFor(() => expect(result.current.data?.status).toBe('completed'), { timeout: 3000 });
    expect(h.get).toHaveBeenCalledWith('/api/v1/repositories/repo/onboarding-pr/workflow');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['repositories'] });
  });
  it('does not request status before submission', async () => {
    renderHook(() => useOnboardingPrStatus('repo', null), { wrapper });
    expect(h.get).not.toHaveBeenCalled();
  });
  it('invalidates repositories after dismissal', async () => {
    h.post.mockResolvedValue({ data: { dismissed: true } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDismissOnboardingChecklist('repo'), { wrapper });
    await result.current.mutateAsync();
    expect(h.post).toHaveBeenCalledWith(
      '/api/v1/repositories/repo/onboarding-checklist/dismiss',
      {}
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['repositories'] });
  });
});
