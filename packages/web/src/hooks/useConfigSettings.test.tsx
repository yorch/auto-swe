// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '@/test/rtl-helpers';
import { useClearConfigSetting, useSetConfigSetting } from './useConfigSettings';

afterEach(() => vi.unstubAllGlobals());

describe('useSetConfigSetting', () => {
  it('settles every concurrent save when each is awaited with mutateAsync', async () => {
    setupFetchMock({
      'PUT /api/v1/platform/config/settings/a': () => ({ data: {} }),
      'PUT /api/v1/platform/config/settings/b': () => ({ data: {} }),
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSetConfigSetting({ scope: 'GLOBAL' }), { wrapper });
    const settled: string[] = [];
    await act(async () => {
      await Promise.all([
        result.current.mutateAsync({ key: 'a', value: 1 }).then(() => settled.push('a')),
        result.current.mutateAsync({ key: 'b', value: 2 }).then(() => settled.push('b')),
      ]);
    });
    expect(settled.sort()).toEqual(['a', 'b']);
  });
});

describe('workflow template scope requests', () => {
  const template = { scope: 'WORKFLOW_TEMPLATE', workflowTemplateId: 'tpl-1' } as const;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
  const lastUrl = (spy: ReturnType<typeof setupFetchMock>) =>
    new URL(String(spy.mock.calls.at(-1)?.[0]), 'http://x');

  it('sends the scope and template id when saving', async () => {
    const spy = setupFetchMock({
      'PUT /api/v1/platform/config/settings/a.b': () => ({ data: {} }),
    });
    const { result } = renderHook(() => useSetConfigSetting(template), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ key: 'a.b', value: 1 });
    });
    const url = lastUrl(spy);
    expect(url.searchParams.get('scope')).toBe('WORKFLOW_TEMPLATE');
    expect(url.searchParams.get('workflowTemplateId')).toBe('tpl-1');
  });

  it('sends the scope and template id when clearing', async () => {
    const spy = setupFetchMock({
      'DELETE /api/v1/platform/config/settings/a.b': () => ({ data: { cleared: true } }),
    });
    const { result } = renderHook(() => useClearConfigSetting(template), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('a.b');
    });
    const url = lastUrl(spy);
    expect(url.searchParams.get('scope')).toBe('WORKFLOW_TEMPLATE');
    expect(url.searchParams.get('workflowTemplateId')).toBe('tpl-1');
  });
});
