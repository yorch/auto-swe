'use client';

import { useCallback, useState } from 'react';
import type { DataTableSort } from '@/components/ui/DataTable';

type SortValue = string | number | null | undefined;

/**
 * Client-side sorting for a `DataTable` whose page holds the whole list. `accessors`
 * maps a sortable column id to the value its rows compare by; declare it at module
 * scope. Until a heading is clicked the rows keep the order they arrived in. A first
 * click sorts ascending and a second click flips the direction. Empty values sort last in
 * both directions, and ties keep their incoming order.
 */
export function useDataTableSort<Row>(accessors: Record<string, (row: Row) => SortValue>) {
  const [sort, setSort] = useState<DataTableSort | null>(null);

  const onSortChange = useCallback((columnId: string) => {
    setSort((current) =>
      current?.columnId === columnId
        ? { columnId, direction: current.direction === 'ascending' ? 'descending' : 'ascending' }
        : { columnId, direction: 'ascending' }
    );
  }, []);

  const sortRows = useCallback(
    (rows: Row[]): Row[] => {
      const accessor = sort ? accessors[sort.columnId] : undefined;
      if (!sort || !accessor) {
        return rows;
      }
      const sign = sort.direction === 'ascending' ? 1 : -1;
      return rows
        .map((row, index) => ({ index, row, value: accessor(row) }))
        .sort((a, b) => {
          const aEmpty = a.value == null || a.value === '';
          const bEmpty = b.value == null || b.value === '';
          if (aEmpty || bEmpty) {
            return aEmpty === bEmpty ? a.index - b.index : aEmpty ? 1 : -1;
          }
          const cmp =
            typeof a.value === 'string' || typeof b.value === 'string'
              ? String(a.value).localeCompare(String(b.value), undefined, { numeric: true })
              : (a.value as number) - (b.value as number);
          return cmp === 0 ? a.index - b.index : cmp * sign;
        })
        .map((entry) => entry.row);
    },
    [accessors, sort]
  );

  return { onSortChange, sort, sortRows };
}
