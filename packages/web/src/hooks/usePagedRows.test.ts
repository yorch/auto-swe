// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePagedRows } from './usePagedRows';

const rows = Array.from({ length: 7 }, (_, i) => i);

describe('usePagedRows', () => {
  it('pages through the rows and reports the range', () => {
    const { result } = renderHook(() => usePagedRows(rows, 3));
    expect(result.current.pageRows).toEqual([0, 1, 2]);
    expect(result.current.paged).toBe(true);
    act(() => result.current.onNext());
    expect(result.current.pageRows).toEqual([3, 4, 5]);
    expect([result.current.rangeStart, result.current.rangeEnd]).toEqual([4, 6]);
    act(() => result.current.onNext());
    expect(result.current.hasNext).toBe(false);
  });

  it('clamps when the list shrinks and returns to page one when the filter key changes', () => {
    const { result, rerender } = renderHook(
      ({ list, key }: { list: number[]; key: string }) => usePagedRows(list, 3, key),
      { initialProps: { key: '', list: rows } }
    );
    act(() => result.current.onNext());
    act(() => result.current.onNext());
    rerender({ key: '', list: rows.slice(0, 4) });
    expect(result.current.pageRows).toEqual([3]);
    rerender({ key: 'x', list: rows });
    expect(result.current.pageRows).toEqual([0, 1, 2]);
  });
});
