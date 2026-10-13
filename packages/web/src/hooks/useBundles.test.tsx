// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '@/test/rtl-helpers';
import { useInstallBundleFromFile, useInstallBundleFromUrl } from './useBundles';

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

// What an install writes, under the keys the pages that list it cache it as.
const CONTENT_KEYS = [
  ['admin-bundles'],
  ['admin-agent-library'],
  ['team-agent-library'],
  ['skills'],
  ['workflow-templates'],
  ['scanner-patterns'],
].map((k) => JSON.stringify(k));

describe('bundle install', () => {
  it('refreshes the installed content after an install from a URL', async () => {
    setupFetchMock({ 'POST /api/v1/platform/bundles/install-from-url': () => ({ data: {} }) });
    const { spy, wrapper } = setup();
    const { result } = renderHook(() => useInstallBundleFromUrl(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        expectedContentHash: 'h',
        overwriteProtected: false,
        url: 'https://example.com/b.json',
      });
    });
    expect(invalidated(spy)).toEqual(expect.arrayContaining(CONTENT_KEYS));
  });

  it('refreshes the installed content after an install from a file', async () => {
    setupFetchMock({ 'POST /api/v1/platform/bundles/install': () => ({ data: {} }) });
    const { spy, wrapper } = setup();
    const { result } = renderHook(() => useInstallBundleFromFile(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        bundle: {},
        expectedContentHash: 'h',
        overwriteProtected: false,
      });
    });
    expect(invalidated(spy)).toEqual(expect.arrayContaining(CONTENT_KEYS));
  });
});
