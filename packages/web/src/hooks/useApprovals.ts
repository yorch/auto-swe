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
  overdueOnly = false,
  runId?: string,
  /** Only steps the current user can answer and has not already answered. */
  actionable = false
) {
  const params = new URLSearchParams();
  if (actionable) {
    params.set('actionable', 'true');
  }
  if (runId) {
    params.set('runId', runId);
  }
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
    queryKey: ['approvals', filter, sort, overdueOnly, runId, actionable],
    // Keep a fallback poll (30 s for pending, and for one run's steps, which show
    // live status; the unscoped history view does not poll).
    refetchInterval: filter === 'PENDING' || runId ? 30_000 : false,
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

/**
 * Count of steps waiting on the current user, for the chrome. Asks the gateway for the
 * total (`count=true`, returned as `meta.total`) rather than measuring the list, which is
 * capped at one page and would under-count the badge.
 */
export function useApprovalsCount(): number {
  const { data } = useQuery({
    queryFn: () =>
      api
        .get<{ data?: unknown; meta?: { total?: unknown } }>(
          '/api/v1/human-steps?actionable=true&limit=1&count=true'
        )
        .then((r) => (typeof r.meta?.total === 'number' ? r.meta.total : 0)),
    // Under the 'approvals' prefix so the SSE stream's invalidation refreshes it.
    queryKey: ['approvals', 'count'],
    // Same 30 s fallback poll as the list queries.
    refetchInterval: 30_000,
  });
  return data ?? 0;
}

export function useRespondToApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      comment,
      value,
    }: {
      id: string;
      action: string;
      comment?: string;
      value?: unknown;
    }) => api.post(`/api/v1/human-steps/${id}/respond`, { action, comment, value }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approvals'] });
      qc.invalidateQueries({ queryKey: ['workflow-run'] });
      qc.invalidateQueries({ queryKey: ['workflow-runs'] });
    },
  });
}
