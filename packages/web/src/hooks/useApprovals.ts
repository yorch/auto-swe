'use client';

import type { HumanStepSummary } from '@auto-swe/shared/types/api';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { API_BASE } from '@/lib/config';

export type ApprovalFilter = 'PENDING' | 'ALL';

function approvalsQueryOptions(filter: ApprovalFilter) {
  return queryOptions({
    queryFn: () =>
      api
        .get<{ data: HumanStepSummary[] }>(
          `/api/v1/human-steps${filter === 'ALL' ? '?status=ALL' : ''}`
        )
        .then((r) => r.data),
    queryKey: ['approvals', filter] as const,
    // Keep a fallback poll (30 s for pending, disabled for history).
    refetchInterval: filter === 'PENDING' ? 30_000 : false,
  });
}

/**
 * Owns the single SSE subscription for approval change notifications and keeps
 * the pending query warm so the sidebar / top-bar badges have data on every
 * page. Mount it exactly once, in the app shell — every extra mount is
 * another EventSource connection against the gateway.
 */
export function useApprovalsStream() {
  const qc = useQueryClient();

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      return;
    }

    const es = new EventSource(`${API_BASE}/api/v1/human-steps/stream`, { withCredentials: true });

    es.addEventListener('change', () => {
      qc.invalidateQueries({ queryKey: ['approvals', 'PENDING'] });
    });

    // Suppress noise — EventSource auto-reconnects on error.
    es.onerror = () => {};

    return () => es.close();
  }, [qc]);

  useQuery(approvalsQueryOptions('PENDING'));
}

export function useApprovals(filter: ApprovalFilter = 'PENDING') {
  return useQuery(approvalsQueryOptions(filter));
}

/**
 * Number of pending human steps, read from the query cache only — the fetch
 * and the SSE subscription belong to `useApprovalsStream()` in the app shell.
 */
export function useApprovalsCount(): number {
  const { data } = useQuery({ ...approvalsQueryOptions('PENDING'), enabled: false });
  return data?.length ?? 0;
}

export function useRespondToApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, value }: { id: string; action: string; value?: unknown }) =>
      api.post(`/api/v1/human-steps/${id}/respond`, { action, value }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approvals'] });
      qc.invalidateQueries({ queryKey: ['workflow-run'] });
    },
  });
}
