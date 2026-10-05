'use client';

import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';
import type {
  GlobalAnalyticsResponse,
  SpecDiffResponse,
  StepRegistryEntry,
  WorkflowRunSummary,
  WorkflowTemplateAnalytics,
  WorkflowTemplateDetail,
  WorkflowTemplateSummary,
  WorkflowTemplateVersionDetail,
} from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { api } from '@/lib/api';
import { type DateRange, rangeKey, rangeQuery } from '@/lib/dateRange';

export function useWorkflowTemplates(teamId?: string | null) {
  return useQuery({
    queryFn: () =>
      api
        .get<{
          data: WorkflowTemplateSummary[];
        }>(`/api/v1/workflow-templates${teamId ? `?teamId=${teamId}` : ''}`)
        .then((r) => r.data),
    queryKey: ['workflow-templates', teamId ?? null],
  });
}

export function useWorkflowTemplate(id: string) {
  return useQuery({
    enabled: !!id,
    queryFn: () =>
      api
        .get<{ data: WorkflowTemplateDetail }>(`/api/v1/workflow-templates/${id}`)
        .then((r) => r.data),
    queryKey: ['workflow-template', id],
  });
}

export function useWorkflowTemplateVersion(id: string, version: number | null) {
  return useQuery({
    enabled: !!id && version !== null,
    queryFn: () =>
      api
        .get<{
          data: WorkflowTemplateVersionDetail;
        }>(`/api/v1/workflow-templates/${id}/versions/${version}`)
        .then((r) => r.data),
    queryKey: ['workflow-template-version', id, version],
  });
}

export function useTemplateRuns(
  id: string,
  { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {}
) {
  return useQuery({
    enabled: !!id,
    queryFn: () =>
      api
        .get<{
          data: WorkflowRunSummary[];
          meta: { total: number };
        }>(`/api/v1/workflow-templates/${id}/runs?limit=${limit}&offset=${offset}`)
        .then((r) => ({ data: r.data, total: r.meta.total })),
    queryKey: ['workflow-template-runs', id, limit, offset],
    refetchInterval: 10_000,
  });
}

export function useStepRegistry() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: StepRegistryEntry[] }>('/api/v1/workflow-steps/registry').then((r) => r.data),
    queryKey: ['step-registry'],
    staleTime: 5 * 60_000,
  });
}

export function useCreateWorkflowTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      description?: string;
      teamId?: string | null;
      spec: unknown;
    }) => api.post<{ data: WorkflowTemplateSummary }>('/api/v1/workflow-templates', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflow-templates'] }),
  });
}

export type WorkflowGenerationJobStatus =
  | { status: 'running'; phase?: string }
  | { status: 'done'; templateId: string; name: string; summary: string; attempts: number }
  | { status: 'failed'; code: string; message: string };

export function useStartWorkflowGenerationJob() {
  return useMutation({
    mutationFn: (body: { prompt: string; name?: string; teamId?: string | null }) =>
      api
        .post<{ data: { jobId: string } }>('/api/v1/workflow-templates/generate/jobs', body)
        .then((r) => r.data),
  });
}

export function useWorkflowGenerationJob(jobId: string | null) {
  return useQuery<WorkflowGenerationJobStatus>({
    enabled: !!jobId,
    queryFn: () =>
      api
        .get<{
          data: WorkflowGenerationJobStatus;
        }>(`/api/v1/workflow-templates/generate/jobs/${jobId}`)
        .then((r) => r.data),
    queryKey: ['workflow-generation-job', jobId],
    // Poll while the job is running; stop once it reaches a terminal state.
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && data.status !== 'running' ? false : 1500;
    },
  });
}

/**
 * The plain-language explanation of a template's active version. Each call is a
 * billed LLM run, so it is fetched once per template + active version and kept
 * for the session; reopening the dialog shows the cached text.
 */
export function useExplainWorkflowTemplate(
  templateId: string,
  activeVersion: number | null,
  enabled: boolean
) {
  return useQuery({
    enabled: enabled && !!templateId,
    gcTime: 60 * 60_000,
    queryFn: () =>
      api
        .post<{
          data: { explanation: string };
        }>(`/api/v1/workflow-templates/${templateId}/explain`, {})
        .then((r) => r.data),
    queryKey: ['workflow-template-explain', templateId, activeVersion],
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useCreateWorkflowVersion(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (spec: unknown) =>
      api.post<{ data: WorkflowTemplateVersionDetail }>(
        `/api/v1/workflow-templates/${templateId}/versions`,
        { spec }
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflow-template', templateId] }),
  });
}

/**
 * Conversationally refine a template: send a plain-language change and the
 * gateway saves a NEW version off the current one. Returns the refined spec +
 * the model's summary so a chat panel can show what changed; invalidates the
 * template query so the canvas reflects the new latest version.
 */
export function useRefineWorkflowTemplate(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (prompt: string) =>
      api.post<{
        data: WorkflowTemplateVersionDetail;
        spec: unknown;
        summary: string;
        attempts: number;
        warnings?: string[];
      }>(`/api/v1/workflow-templates/${templateId}/refine`, { prompt }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflow-template', templateId] }),
  });
}

export function usePromoteWorkflowVersion(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (version: number) =>
      api.post(`/api/v1/workflow-templates/${templateId}/promote`, { version }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow-template', templateId] });
      qc.invalidateQueries({ queryKey: ['workflow-templates'] });
    },
  });
}

export function useReviewWorkflowVersion(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (version: number) =>
      api.post(`/api/v1/workflow-templates/${templateId}/versions/${version}/review`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow-template', templateId] });
      qc.invalidateQueries({ queryKey: ['workflow-template-version', templateId] });
    },
  });
}

export function useUpdateWorkflowTemplate(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      body: Partial<{
        name: string;
        description: string;
        isDefault: boolean;
        status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
        experimentVersion: number | null;
        experimentSplit: number | null;
        inputSchema: InputSchema | null;
        estimatedHumanTimeSavedMinutes: number | null;
      }>
    ) =>
      api.patch<{ data: WorkflowTemplateSummary }>(
        `/api/v1/workflow-templates/${templateId}`,
        body
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow-template', templateId] });
      qc.invalidateQueries({ queryKey: ['workflow-templates'] });
    },
  });
}

export function useWorkflowSpecDiff(templateId: string, a: number | null, b: number | null) {
  return useQuery({
    enabled: !!templateId && a !== null && b !== null && a !== b,
    queryFn: () =>
      api
        .get<{ data: SpecDiffResponse }>(
          `/api/v1/workflow-templates/${templateId}/diff?a=${a}&b=${b}`
        )
        .then((r) => r.data),
    queryKey: ['workflow-template-diff', templateId, a, b],
    staleTime: 60_000,
  });
}

export function useWorkflowTemplateAnalytics(templateId: string, windowDays = 30) {
  return useQuery({
    enabled: !!templateId,
    queryFn: () =>
      api
        .get<{ data: WorkflowTemplateAnalytics }>(
          `/api/v1/workflow-templates/${templateId}/analytics?window=${windowDays}`
        )
        .then((r) => r.data),
    queryKey: ['workflow-template-analytics', templateId, windowDays],
    refetchInterval: 30_000,
  });
}

export function useGlobalAnalytics(range: DateRange = { days: 30, kind: 'preset' }) {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: GlobalAnalyticsResponse }>(
          `/api/v1/workflow-templates/analytics?${new URLSearchParams(rangeQuery(range))}`
        )
        .then((r) => r.data),
    queryKey: ['global-analytics', rangeKey(range)],
    refetchInterval: 30_000,
  });
}

export function useRegenerateWebhook(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api
        .post<{ data: { webhookToken: string } }>(
          `/api/v1/workflow-templates/${templateId}/webhook/regenerate`,
          {}
        )
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflow-template', templateId] }),
  });
}

export function useRevokeWebhook(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>(`/api/v1/workflow-templates/${templateId}/webhook`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflow-template', templateId] }),
  });
}

export function useRunTemplate(templateId: string) {
  const qc = useQueryClient();
  const submission = useRef<{ body: string; key: string } | null>(null);
  return useMutation({
    mutationFn: (body: { payload?: Record<string, unknown>; label?: string }) => {
      const serialized = JSON.stringify(body);
      if (!submission.current || submission.current.body !== serialized) {
        submission.current = { body: serialized, key: crypto.randomUUID() };
      }
      return api
        .fetch<{ data: { temporalWorkflowId: string; workflowId: string; workRequestId: string } }>(
          `/api/v1/workflow-templates/${templateId}/runs`,
          {
            body: serialized,
            headers: { 'Idempotency-Key': submission.current.key },
            method: 'POST',
          }
        )
        .then((r) => r.data);
    },
    onSuccess: () => {
      submission.current = null;
      qc.invalidateQueries({ queryKey: ['workflow-template-runs', templateId] });
      qc.invalidateQueries({ queryKey: ['workflow-runs'] });
    },
  });
}
