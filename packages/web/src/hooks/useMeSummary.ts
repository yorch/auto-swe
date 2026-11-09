'use client';

import type { MeSummary } from '@auto-swe/shared/types/api';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * The signed-in user's cross-team desk: what needs them and which teams they are in. Its own key,
 * not under `'approvals'`: the approvals SSE stream fires for every approval on the platform and
 * would refetch every open desk. The desk polls instead, and the mutations that change what is on
 * it (answering an approval, cancelling, retrying, launching) invalidate this key.
 */
export const ME_SUMMARY_KEY = ['me-summary'] as const;

export function useMeSummary() {
  return useQuery({
    queryFn: () => api.get<MeSummary>('/api/v1/me/summary'),
    queryKey: ME_SUMMARY_KEY,
    refetchInterval: 20_000,
  });
}
