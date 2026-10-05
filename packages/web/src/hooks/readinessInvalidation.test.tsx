// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '@/test/rtl-helpers';
import { useUpdateGitHubConfig } from './useAdminConfig';
import { useCreateRepository } from './useRepositories';
import { useRestoreSkillRevision } from './useSkills';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { spy, wrapper };
}

const invalidated = (spy: ReturnType<typeof setup>['spy']) =>
  spy.mock.calls.map(([f]) => JSON.stringify((f as { queryKey: unknown }).queryKey));

describe('cache invalidation', () => {
  it('refreshes setup readiness when GitHub config is saved', async () => {
    setupFetchMock({ 'PUT /api/v1/platform/config/github': () => ({ data: {} }) });
    const { spy, wrapper } = setup();
    const { result } = renderHook(() => useUpdateGitHubConfig(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({} as never);
    });
    expect(invalidated(spy)).toContain(JSON.stringify(['platform-readiness']));
  });

  it('refreshes setup readiness when a repository is connected', async () => {
    setupFetchMock({ 'POST /api/v1/repositories': () => ({ data: {} }) });
    const { spy, wrapper } = setup();
    const { result } = renderHook(() => useCreateRepository(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({} as never);
    });
    expect(invalidated(spy)).toContain(JSON.stringify(['platform-readiness']));
  });

  it('refreshes the agent library when a skill revision is restored', async () => {
    setupFetchMock({
      'POST /api/v1/platform/skills/s1/revisions/2/restore': () => ({ data: { id: 's1' } }),
    });
    const { spy, wrapper } = setup();
    const { result } = renderHook(() => useRestoreSkillRevision(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 's1', revision: 2 });
    });
    expect(invalidated(spy)).toContain(JSON.stringify(['admin-agent-library']));
  });
});
