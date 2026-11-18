'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import {
  type ApprovedPlan,
  type PlanJob,
  pollDelayMs,
  type RouteResult,
  type RunPlanListItem,
  type RunPlanView,
} from '@/lib/runPlan';

const PLANS_KEY = ['run-plans'] as const;

/** Rank the templates the caller may launch for a goal. */
export function useRoutePlan() {
  return useMutation({
    mutationFn: (body: { intent: string; repoId: string }) =>
      api
        .fetch<{ data: RouteResult }>('/api/v1/run-plans/route', {
          body: JSON.stringify(body),
          method: 'POST',
        })
        .then((r) => r.data),
  });
}

/** Start a generation job. The Idempotency-Key is chosen by the caller (one per attempt). */
export function useStartPlanJob() {
  return useMutation({
    mutationFn: ({
      body,
      idempotencyKey,
    }: {
      body: Record<string, unknown>;
      idempotencyKey: string;
    }) =>
      api
        .fetch<{ data: { jobId: string } }>('/api/v1/run-plans', {
          body: JSON.stringify(body),
          headers: { 'Idempotency-Key': idempotencyKey },
          method: 'POST',
        })
        .then((r) => r.data.jobId),
  });
}

/**
 * Poll a generation job with growing delays. Polling stops when the job is done or failed, when
 * the read itself fails, and when the component using the hook unmounts (the observer goes away
 * with it), so a closed tab or a navigation never leaves a timer running.
 */
export function usePlanJob(jobId: string | null) {
  return useQuery({
    enabled: jobId !== null,
    queryFn: () =>
      api
        .get<{ data: PlanJob }>(`/api/v1/run-plans/jobs/${encodeURIComponent(jobId ?? '')}`)
        .then((r) => r.data),
    queryKey: [...PLANS_KEY, 'job', jobId],
    refetchInterval: (query) =>
      query.state.status === 'error' || query.state.data?.status !== 'running'
        ? false
        : pollDelayMs(query.state.dataUpdateCount - 1),
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 0,
  });
}

export function useRunPlan(planId: string | null) {
  return useQuery({
    enabled: planId !== null,
    queryFn: () =>
      api
        .get<{ data: RunPlanView }>(`/api/v1/run-plans/${encodeURIComponent(planId ?? '')}`)
        .then((r) => r.data),
    queryKey: [...PLANS_KEY, 'plan', planId],
    retry: false,
  });
}

export function useRunPlans() {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: RunPlanListItem[]; meta: { total: number } }>('/api/v1/run-plans?limit=20')
        .then((r) => r),
    queryKey: [...PLANS_KEY, 'list'],
  });
}

export function useApprovePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, idempotencyKey }: { id: string; idempotencyKey: string }) =>
      api
        .fetch<{ data: ApprovedPlan }>(`/api/v1/run-plans/${encodeURIComponent(id)}/approve`, {
          body: JSON.stringify({}),
          headers: { 'Idempotency-Key': idempotencyKey },
          method: 'POST',
        })
        .then((r) => r.data),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: PLANS_KEY });
      qc.invalidateQueries({ queryKey: ['workflows'] });
      qc.invalidateQueries({ queryKey: ['workflow-runs'] });
    },
  });
}

export function useRejectPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.fetch(`/api/v1/run-plans/${encodeURIComponent(id)}/reject`, {
        body: JSON.stringify({}),
        method: 'POST',
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: PLANS_KEY }),
  });
}
