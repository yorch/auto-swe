'use client';

import type { CreateEpicResponse, EpicDetail, EpicSummary } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useCreateEpic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { externalTicketId: string; description: string; repoIds: string[] }) =>
      api.post<{ data: CreateEpicResponse }>('/api/v1/epics', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['epics'] });
      qc.invalidateQueries({ queryKey: ['workflows'] });
    },
  });
}

export function useEpics(filters: { limit?: number; offset?: number } = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(filters.limit ?? 50));
  params.set('offset', String(filters.offset ?? 0));
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: EpicSummary[]; meta: { limit: number; offset: number; total: number } }>(
          `/api/v1/epics?${params.toString()}`
        )
        .then((r) => ({ data: r.data, meta: r.meta })),
    queryKey: ['epics', filters],
    refetchInterval: 10_000,
  });
}

export function useEpic(workflowId: string) {
  return useQuery({
    enabled: !!workflowId,
    queryFn: () =>
      api
        .get<{ data: EpicDetail }>(`/api/v1/epics/${encodeURIComponent(workflowId)}`)
        .then((r) => r.data),
    queryKey: ['epic', workflowId],
    refetchInterval: 10_000,
    // The epic's ActiveWorkflow row only appears after the orchestrator's first
    // state update — tolerate a brief 404 right after creation before erroring.
    // (~30s with the default exponential backoff; refetchInterval keeps polling
    // after that, so a late-registering epic still recovers.)
    retry: 5,
  });
}
