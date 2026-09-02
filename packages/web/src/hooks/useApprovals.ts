'use client';

import type { HumanStepSummary } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { API_BASE } from '@/lib/config';

export type ApprovalFilter = 'PENDING' | 'ALL';

export function useApprovals(filter: ApprovalFilter = 'PENDING') {
  const qc = useQueryClient();

  // SSE subscription — real-time change notifications for the pending view.
  useEffect(() => {
    if (filter !== 'PENDING') {
      return;
    }
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
  }, [filter, qc]);

  return useQuery({
    queryFn: () =>
      api
        .get<{ data: HumanStepSummary[] }>(
          `/api/v1/human-steps${filter === 'ALL' ? '?status=ALL' : ''}`
        )
        .then((r) => r.data),
    queryKey: ['approvals', filter],
    // Keep a fallback poll (30 s for pending, disabled for history).
    refetchInterval: filter === 'PENDING' ? 30_000 : false,
  });
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
