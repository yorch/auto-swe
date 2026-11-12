// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEntityTitleStore } from '@/stores/entityTitleStore';
import { resetNavigation } from '@/test/mockNavigation';
import { useEntityTitle } from './useEntityTitle';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());
beforeEach(() => {
  resetNavigation('', '/library/id');
  useEntityTitleStore.setState({ entry: null });
});
afterEach(cleanup);

describe('entity breadcrumb titles', () => {
  it('publishes the loaded name, updates it, and clears on unmount', () => {
    const { rerender, unmount } = renderHook(({ title }) => useEntityTitle(title), {
      initialProps: { title: 'ticket-to-merge' },
    });
    expect(useEntityTitleStore.getState().entry).toMatchObject({
      pathname: '/library/id',
      title: 'ticket-to-merge',
    });
    rerender({ title: 'Renamed workflow' });
    expect(useEntityTitleStore.getState().entry?.title).toBe('Renamed workflow');
    unmount();
    expect(useEntityTitleStore.getState().entry).toBeNull();
  });
  it.each([null, undefined, '', '   '])(
    'leaves the route fallback while the title is %s',
    (title) => {
      renderHook(() => useEntityTitle(title));
      expect(useEntityTitleStore.getState().entry).toBeNull();
    }
  );
  it('clears the previous title on a route change or failed load', () => {
    const { rerender } = renderHook(
      ({ title }: { title: string | null }) => useEntityTitle(title),
      { initialProps: { title: 'First' as string | null } }
    );
    resetNavigation('', '/runs/other');
    rerender({ title: null });
    expect(useEntityTitleStore.getState().entry).toBeNull();
  });
  it('does not let a late cleanup erase a new page publisher', () => {
    const old = renderHook(() => useEntityTitle('First'));
    resetNavigation('', '/runs/other');
    renderHook(() => useEntityTitle('Second', { href: '/runs', label: 'All runs' }));
    act(() => old.unmount());
    expect(useEntityTitleStore.getState().entry).toMatchObject({
      parent: { href: '/runs', label: 'All runs' },
      pathname: '/runs/other',
      title: 'Second',
    });
  });
});
