'use client';

import type { OnboardingRequest } from '@auto-swe/shared/lib/onboardingPr';
import type { OnboardingPrResult } from '@auto-swe/shared/lib/onboardingPrWorkflow';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@/lib/api';

export function useOnboardingToolCatalog() {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: { key: string; status: string }[] }>('/api/v1/platform/tool-catalog')
        .then((r) => [...new Set(r.data.filter((t) => t.status !== 'REVOKED').map((t) => t.key))]),
    queryKey: ['onboarding-tool-catalog'],
  });
}

export function useOpenOnboardingPr(id: string) {
  return useMutation({
    mutationFn: (body: OnboardingRequest) =>
      api
        .post<{ data: { workflowId: string } }>(`/api/v1/repositories/${id}/onboarding-pr`, body)
        .then((r) => r.data),
  });
}

interface OnboardingStatus {
  status: 'running' | 'completed' | 'failed';
  result?: OnboardingPrResult;
  error?: string;
}

export function useOnboardingPrStatus(id: string, workflowId: string | null) {
  const qc = useQueryClient();
  const query = useQuery({
    enabled: workflowId !== null,
    queryFn: () =>
      api
        .get<{ data: OnboardingStatus }>(
          `/api/v1/repositories/${id}/onboarding-pr/${encodeURIComponent(workflowId ?? '')}`
        )
        .then((r) => r.data),
    queryKey: ['onboarding-pr', id, workflowId],
    refetchInterval: (q) => (!q.state.data || q.state.data.status === 'running' ? 1500 : false),
  });
  useEffect(() => {
    if (query.data?.status === 'completed') {
      qc.invalidateQueries({ queryKey: ['repositories'] });
    }
  }, [qc, query.data]);
  return query;
}

export function useDismissOnboardingChecklist(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`/api/v1/repositories/${id}/onboarding-checklist/dismiss`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repositories'] }),
  });
}
