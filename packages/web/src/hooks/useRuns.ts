'use client';

import type {
  WorkflowDetail,
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowSummary,
} from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface CreateWorkRequestBody {
  externalTicketId: string;
  description: string;
  repoIds: string[];
  budgetTier?: 'STANDARD' | 'LARGE' | 'EPIC';
}

export interface CreateWorkRequestResponse {
  data: { workflowIds: string[]; workRequestId: string };
}

export function useWorkflows() {
  return useQuery({
    queryFn: () => api.get<{ data: WorkflowSummary[] }>('/api/v1/workflows').then((r) => r.data),
    queryKey: ['workflows'],
    refetchInterval: 10_000,
  });
}

export function useWorkflow(id: string) {
  return useQuery({
    enabled: !!id,
    queryFn: () => api.get<{ data: WorkflowDetail }>(`/api/v1/workflows/${id}`).then((r) => r.data),
    queryKey: ['workflow', id],
    refetchInterval: 5_000,
  });
}

export function useWorkflowRun(id: string, includeTraces = true) {
  return useQuery({
    enabled: !!id,
    queryFn: () =>
      api
        .get<{ data: WorkflowRunDetail }>(
          `/api/v1/workflow-runs/${id}${includeTraces ? '?includeTraces=true' : ''}`
        )
        .then((r) => r.data),
    queryKey: ['workflow-run', id, includeTraces],
    refetchInterval: (q) => {
      const data = q.state.data as WorkflowRunDetail | undefined;
      return data?.status === 'RUNNING' ? 3_000 : 30_000;
    },
  });
}

export function useAllWorkflowRuns(
  filters: { status?: string; templateId?: string; limit?: number; offset?: number } = {}
) {
  const params = new URLSearchParams();
  if (filters.status) {
    params.set('status', filters.status);
  }
  if (filters.templateId) {
    params.set('templateId', filters.templateId);
  }
  params.set('limit', String(filters.limit ?? 50));
  params.set('offset', String(filters.offset ?? 0));
  return useQuery({
    queryFn: () =>
      api
        .get<{
          data: WorkflowRunSummary[];
          meta: { limit: number; offset: number; total: number };
        }>(`/api/v1/workflow-runs?${params.toString()}`)
        .then((r) => ({ data: r.data, meta: r.meta })),
    queryKey: ['workflow-runs', filters],
    refetchInterval: 10_000,
  });
}

export function useRunsForWorkRequest(workRequestId?: string) {
  return useQuery({
    enabled: !!workRequestId,
    queryFn: () =>
      api
        .get<{ data: WorkflowRunSummary[] }>(
          `/api/v1/workflow-runs?workRequestId=${workRequestId}&limit=20&offset=0`
        )
        .then((r) => r.data),
    queryKey: ['workflow-runs', 'by-work-request', workRequestId],
    refetchInterval: 10_000,
  });
}

export function useCancelWorkflowRun(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`/api/v1/workflow-runs/${runId}/cancel`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow-run', runId] });
      qc.invalidateQueries({ queryKey: ['workflows'] });
    },
  });
}

export function useCreateWorkRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWorkRequestBody) =>
      api.post<CreateWorkRequestResponse>('/api/v1/work-requests', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
  });
}
