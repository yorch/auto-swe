'use client';

import { useState } from 'react';

export const DEFAULT_PAGE_SIZE = 25;

/**
 * Client-side paging for a list that already holds every row. The page clamps
 * when the list shrinks (a filter, a revoke) so the viewer never lands past the
 * end. Pass `resetKey` (a filter signature) to return to the first page when it changes.
 */
export function usePagedRows<Row>(rows: Row[], pageSize = DEFAULT_PAGE_SIZE, resetKey = '') {
  const [page, setPage] = useState(0);
  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    // Adjusting state during render is React's sanctioned way to reset on a prop change.
    setSeenKey(resetKey);
    setPage(0);
  }
  const lastPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1);
  const current = Math.min(page, lastPage);
  const start = current * pageSize;
  return {
    hasNext: start + pageSize < rows.length,
    hasPrev: current > 0,
    onNext: () => setPage(current + 1),
    onPrev: () => setPage(Math.max(0, current - 1)),
    paged: rows.length > pageSize,
    pageRows: rows.slice(start, start + pageSize),
    rangeEnd: Math.min(start + pageSize, rows.length),
    rangeStart: rows.length === 0 ? 0 : start + 1,
    total: rows.length,
  };
}
