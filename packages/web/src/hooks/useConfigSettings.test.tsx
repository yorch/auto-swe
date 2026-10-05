// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '@/test/rtl-helpers';
import { useSetConfigSetting } from './useConfigSettings';

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
