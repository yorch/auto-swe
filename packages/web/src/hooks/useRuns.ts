'use client';

import type {
  AutonomyDecisionDto,
  EvalResultDto,
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
  return useQuery<WorkflowRunDetail>({
    enabled: !!id,
    queryFn: () =>
      api
        .get<{ data: WorkflowRunDetail }>(
          `/api/v1/workflow-runs/${id}${includeTraces ? '?includeTraces=true' : ''}`
        )
        .then((r) => r.data),
    queryKey: ['workflow-run', id, includeTraces],
    refetchInterval: (q) => {
      const data = q.state.data;
      return data?.status === 'RUNNING' ? 3_000 : 30_000;
    },
  });
}

/** P0 evals: captured quality signals (gate / review / merge) for a run. */
export function useEvalResultsForRun(runId?: string) {
  return useQuery({
    enabled: !!runId,
    queryFn: () =>
      api
        .get<{ data: EvalResultDto[] }>(`/api/v1/workflow-runs/${runId}/eval-results`)
        .then((r) => r.data),
    queryKey: ['eval-results', runId],
    refetchInterval: 10_000,
  });
}

/** P3 governance: autonomy decisions for a run. */
export function useAutonomyDecisionsForRun(runId?: string) {
  return useQuery({
    enabled: !!runId,
    queryFn: () =>
      api
        .get<{ data: AutonomyDecisionDto[] }>(`/api/v1/workflow-runs/${runId}/autonomy-decisions`)
        .then((r) => r.data),
    queryKey: ['autonomy-decisions', runId],
    refetchInterval: 10_000,
  });
}

export function useAllWorkflowRuns(
  filters: {
    status?: string;
    templateId?: string;
    limit?: number;
    offset?: number;
    includeChannel?: boolean;
  } = {}
) {
  const params = new URLSearchParams();
  if (filters.status) {
    params.set('status', filters.status);
  }
  if (filters.templateId) {
    params.set('templateId', filters.templateId);
  }
  if (filters.includeChannel) {
    params.set('includeChannel', 'true');
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

export function useRetryWorkRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workRequestId: string) =>
      api.post<CreateWorkRequestResponse>(`/api/v1/work-requests/${workRequestId}/retry`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflows'] });
      qc.invalidateQueries({ queryKey: ['workflow-runs'] });
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
