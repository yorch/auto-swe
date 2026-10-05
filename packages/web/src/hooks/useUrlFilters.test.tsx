// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ replace: vi.fn(), search: 'a=1&offset=30' }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/workflows',
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import { parseOffset, useUrlFilters } from './useUrlFilters';

describe('parseOffset', () => {
  it('accepts non-negative integers and nothing else', () => {
    expect(parseOffset('30')).toBe(30);
    expect(parseOffset(null)).toBe(0);
    expect(parseOffset('-5')).toBe(0);
    expect(parseOffset('1.5')).toBe(0);
    expect(parseOffset('abc')).toBe(0);
    expect(parseOffset('1e400')).toBe(0);
  });
});

describe('useUrlFilters', () => {
  it('patches parameters, drops empty ones, and replaces rather than pushes', () => {
    const { result } = renderHook(() => useUrlFilters());
    result.current.update({ offset: null, state: 'failed' });
    expect(nav.replace).toHaveBeenCalledWith('/workflows?a=1&state=failed', { scroll: false });
  });

  it('leaves a bare path when every parameter is removed', () => {
    nav.search = 'offset=30';
    const { result } = renderHook(() => useUrlFilters());
    result.current.update({ offset: '' });
    expect(nav.replace).toHaveBeenLastCalledWith('/workflows', { scroll: false });
  });
});
