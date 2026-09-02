'use client';

import type { HumanStepSummary } from '@auto-swe/shared/types/api';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { API_BASE } from '@/lib/config';

export type InboxFilter = 'PENDING' | 'ALL';

function inboxQueryOptions(filter: InboxFilter) {
  return queryOptions({
    queryFn: () =>
      api
        .get<{ data: HumanStepSummary[] }>(`/api/v1/inbox${filter === 'ALL' ? '?status=ALL' : ''}`)
        .then((r) => r.data),
    queryKey: ['inbox', filter] as const,
    // Keep a fallback poll (30 s for pending, disabled for history).
    refetchInterval: filter === 'PENDING' ? 30_000 : false,
  });
}

/**
 * Owns the single SSE subscription for inbox change notifications and keeps
 * the pending query warm so the sidebar / top-bar badges have data on every
 * page. Mount it exactly once, in the app shell — every extra mount is
 * another EventSource connection against the gateway.
 */
export function useInboxStream() {
  const qc = useQueryClient();

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      return;
    }

    const es = new EventSource(`${API_BASE}/api/v1/inbox/stream`, { withCredentials: true });

    es.addEventListener('change', () => {
      qc.invalidateQueries({ queryKey: ['inbox', 'PENDING'] });
    });

    // Suppress noise — EventSource auto-reconnects on error.
    es.onerror = () => {};

    return () => es.close();
  }, [qc]);

  useQuery(inboxQueryOptions('PENDING'));
}

export function useInbox(filter: InboxFilter = 'PENDING') {
  return useQuery(inboxQueryOptions(filter));
}

/**
 * Number of pending human steps, read from the query cache only — the fetch
 * and the SSE subscription belong to `useInboxStream()` in the app shell.
 */
export function useInboxCount(): number {
  const { data } = useQuery({ ...inboxQueryOptions('PENDING'), enabled: false });
  return data?.length ?? 0;
}

export function useRespondToHumanStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, value }: { id: string; action: string; value?: unknown }) =>
      api.post(`/api/v1/inbox/${id}/respond`, { action, value }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inbox'] });
      qc.invalidateQueries({ queryKey: ['workflow-run'] });
    },
  });
}
