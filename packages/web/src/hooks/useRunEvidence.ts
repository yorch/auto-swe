'use client';

import type { RunEvidenceDto } from '@auto-swe/shared/types/api';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface RunEvidenceLink {
  url: string;
  expiresAt: string;
}

export function useRunEvidence(runId: string, live: boolean) {
  return useQuery({
    enabled: !!runId,
    queryFn: () =>
      api
        .get<{ data: RunEvidenceDto[] }>(`/api/v1/workflow-runs/${runId}/evidence`)
        .then((r) => r.data),
    queryKey: ['run-evidence', runId],
    refetchInterval: live ? 5_000 : false,
  });
}

export function useRunEvidenceLink(runId: string, evidenceId: string, enabled: boolean) {
  return useQuery({
    enabled: !!runId && !!evidenceId && enabled,
    queryFn: () =>
      api
        .post<{ data: RunEvidenceLink }>(
          `/api/v1/workflow-runs/${runId}/evidence/${evidenceId}/link`,
          {}
        )
        .then((r) => r.data),
    queryKey: ['run-evidence-link', runId, evidenceId],
    retry: false,
    staleTime: 0,
  });
}
