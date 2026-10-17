// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDataTableSort } from './useDataTableSort';

interface Row {
  id: string;
  name: string;
  count: number | null;
}

const ROWS: Row[] = [
  { count: 2, id: 'a', name: 'beta' },
  { count: null, id: 'b', name: 'Alpha' },
  { count: 10, id: 'c', name: 'gamma' },
  { count: 2, id: 'd', name: 'delta' },
];

const ACCESSORS = {
  count: (r: Row) => r.count,
  name: (r: Row) => r.name,
};

const ids = (rows: Row[]) => rows.map((r) => r.id).join('');

describe('useDataTableSort', () => {
  it('keeps the incoming order until a heading is clicked', () => {
    const { result } = renderHook(() => useDataTableSort<Row>(ACCESSORS));
    expect(result.current.sort).toBeNull();
    expect(result.current.sortRows(ROWS)).toBe(ROWS);
  });

  it('sorts ascending on the first click and flips on the second', () => {
    const { result } = renderHook(() => useDataTableSort<Row>(ACCESSORS));
    act(() => result.current.onSortChange('name'));
    expect(result.current.sort).toEqual({ columnId: 'name', direction: 'ascending' });
    expect(ids(result.current.sortRows(ROWS))).toBe('badc');
    act(() => result.current.onSortChange('name'));
    expect(result.current.sort?.direction).toBe('descending');
    expect(ids(result.current.sortRows(ROWS))).toBe('cdab');
  });

  it('sorts numbers numerically, puts empty values last either way and keeps ties stable', () => {
    const { result } = renderHook(() => useDataTableSort<Row>(ACCESSORS));
    act(() => result.current.onSortChange('count'));
    expect(ids(result.current.sortRows(ROWS))).toBe('adcb');
    act(() => result.current.onSortChange('count'));
    expect(ids(result.current.sortRows(ROWS))).toBe('cadb');
  });

  it('ignores a column that has no accessor', () => {
    const { result } = renderHook(() => useDataTableSort<Row>(ACCESSORS));
    act(() => result.current.onSortChange('missing'));
    expect(result.current.sortRows(ROWS)).toBe(ROWS);
  });
});
