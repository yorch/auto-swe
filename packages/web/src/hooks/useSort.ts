'use client';

import { useCallback, useState } from 'react';
import type { SortDirection } from '@/components/ui/Table';

/**
 * Click-to-sort state for a table: `toggle(key)` sorts by a new column
 * descending (or ascending for `ascendingFirst` columns such as names) and flips
 * the direction when the same column is clicked again. `direction(key)` is what
 * `Th`'s `sort` prop takes, and `compare` orders two numbers or strings.
 */
export function useSort<K extends string>(
  initial: K,
  opts: { ascendingFirst?: readonly K[] } = {}
) {
  const [key, setKey] = useState<K>(initial);
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const toggle = useCallback(
    (next: K) => {
      if (next === key) {
        setDir((d) => (d === 'desc' ? 'asc' : 'desc'));
        return;
      }
      setKey(next);
      setDir(opts.ascendingFirst?.includes(next) ? 'asc' : 'desc');
    },
    [key, opts.ascendingFirst]
  );
  const direction = (k: K): SortDirection =>
    k !== key ? 'none' : dir === 'desc' ? 'descending' : 'ascending';
  const compare = (a: number | string, b: number | string): number => {
    const cmp = typeof a === 'string' ? a.localeCompare(String(b)) : a - (b as number);
    return dir === 'desc' ? -cmp : cmp;
  };
  return { compare, direction, key, toggle };
}
