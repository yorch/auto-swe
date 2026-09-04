'use client';

import type { HumanStepSummary } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { API_BASE } from '@/lib/config';

export type ApprovalFilter = 'PENDING' | 'ALL';
export type ApprovalSort =
  | 'requestedAt:asc'
  | 'requestedAt:desc'
  | 'timeoutAt:asc'
  | 'timeoutAt:desc';

export function useApprovals(
  filter: ApprovalFilter = 'PENDING',
  sort: ApprovalSort = 'requestedAt:desc',
  overdueOnly = false
) {
  const params = new URLSearchParams();
  if (filter === 'ALL') {
    params.set('status', 'ALL');
  }
  if (sort !== 'requestedAt:desc') {
    params.set('sort', sort);
  }
  if (overdueOnly) {
    params.set('overdue', 'true');
  }
  const qs = params.toString();

  return useQuery({
    queryFn: () =>
      api
        .get<{ data: HumanStepSummary[] }>(`/api/v1/human-steps${qs ? `?${qs}` : ''}`)
        .then((r) => r.data),
    queryKey: ['approvals', filter, sort, overdueOnly],
    // Keep a fallback poll (30 s for pending, disabled for history).
    refetchInterval: filter === 'PENDING' ? 30_000 : false,
  });
}

/**
 * SSE subscription for the pending-approvals set. Mounted ONCE in AppShell —
 * every consumer of `useApprovals()` (sidebar badge, top bar, approvals page)
 * previously opened its own EventSource, i.e. three long-lived connections per
 * page. A change event invalidates every approvals query; the 30 s poll in
 * `useApprovals` remains as the fallback.
 */
export function useApprovalsStream() {
  const qc = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      return;
    }
    const es = new EventSource(`${API_BASE}/api/v1/human-steps/stream`, { withCredentials: true });
    es.addEventListener('change', () => {
      qc.invalidateQueries({ queryKey: ['approvals'] });
    });
    // Suppress noise — EventSource auto-reconnects on error.
    es.onerror = () => {};
    return () => es.close();
  }, [qc]);
}

/** Pending-approval count for the chrome; shares the default `useApprovals` cache entry. */
export function useApprovalsCount(): number {
  const { data } = useApprovals();
  return (data ?? []).length;
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
