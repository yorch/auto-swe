'use client';

import type { HumanStepSummary } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { API_BASE } from '@/lib/config';

export type InboxFilter = 'PENDING' | 'ALL';

export function useInbox(filter: InboxFilter = 'PENDING') {
  const qc = useQueryClient();

  // SSE subscription — real-time change notifications for the pending view.
  useEffect(() => {
    if (filter !== 'PENDING') {
      return;
    }
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
  }, [filter, qc]);

  return useQuery({
    queryFn: () =>
      api
        .get<{ data: HumanStepSummary[] }>(`/api/v1/inbox${filter === 'ALL' ? '?status=ALL' : ''}`)
        .then((r) => r.data),
    queryKey: ['inbox', filter],
    // Keep a fallback poll (30 s for pending, disabled for history).
    refetchInterval: filter === 'PENDING' ? 30_000 : false,
  });
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
