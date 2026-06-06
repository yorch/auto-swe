'use client';

import type { HumanStepSummary } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useInbox() {
  return useQuery({
    queryFn: () => api.get<{ data: HumanStepSummary[] }>('/api/v1/inbox').then((r) => r.data),
    queryKey: ['inbox'],
    refetchInterval: 10_000,
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
