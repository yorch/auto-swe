'use client';

import { useQuery } from '@tanstack/react-query';

/** The `meta` block every paginated gateway list returns. */
export interface ListMeta {
  limit: number;
  offset: number;
  total: number;
}

export interface ListPage<T> {
  data: T[];
  meta: ListMeta;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
}

/** Append `limit` / `offset` to a list endpoint, keeping the bare path when neither is set. */
export function listUrl(path: string, opts: ListOptions = {}): string {
  const qs = new URLSearchParams();
  if (opts.limit !== undefined) {
    qs.set('limit', String(opts.limit));
  }
  if (opts.offset) {
    qs.set('offset', String(opts.offset));
  }
  const query = qs.toString();
  return query ? `${path}${path.includes('?') ? '&' : '?'}${query}` : path;
}

/**
 * A `useQuery` over a `{ data, meta }` list response that hands callers the
 * rows as `data` and the pagination block as `meta`. The gateway caps every
 * list at a default page size, so a hook that unwraps `data` alone silently
 * drops the total and the page shows "N total" for a page, not the table.
 */
export function useListQuery<T>(options: {
  queryKey: readonly unknown[];
  queryFn: () => Promise<ListPage<T>>;
  enabled?: boolean;
  refetchInterval?: number | false;
}) {
  const query = useQuery(options);
  return { ...query, data: query.data?.data, meta: query.data?.meta };
}
