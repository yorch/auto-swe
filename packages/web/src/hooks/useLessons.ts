'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ListOptions, listUrl, useListQuery } from '@/hooks/useListQuery';
import { api } from '@/lib/api';

export interface LessonRepoStats {
  id: string;
  organizationName: string;
  repoName: string;
  activeCount: number;
  consolidatedCount: number;
  totalCount: number;
  lastConsolidatedAt: string | null;
}

export interface Lesson {
  id: string;
  lessonSummary: string;
  rationale: string | null;
  failureType: string | null;
  /** The writer's own grade of its evidence, 0–1; null where no model judged it. */
  confidence: number | null;
  consolidatedAt: string | null;
  createdAt: string;
  /** `outcome` (the run's end, written by code) and `evidence`, among others. */
  metadata: { outcome?: unknown } | null;
  /** The run the lesson was written from, when one was recorded. */
  workflowRunId: string | null;
  /**
   * Null once the repository is deleted: the lesson's `repoId` is set null with
   * it, and the lesson stays in the list until an admin deletes it.
   */
  repository: { id: string; organizationName: string; repoName: string } | null;
  workflow: { id: string; temporalWorkflowId: string; currentStatus: string } | null;
}

/** Every team's repositories, so the gateway answers it to platform ADMINs only. */
export function useAdminLessonStats() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: LessonRepoStats[] }>('/api/v1/lessons/stats').then((r) => r.data),
    queryKey: ['admin-lesson-stats'],
  });
}

export interface LessonListOptions extends ListOptions {
  /** Only lessons whose summary or rationale contains this text. */
  q?: string;
  repoId?: string;
}

export function useLessons(includeConsolidated = false, opts: LessonListOptions = {}) {
  const { q, repoId, ...page } = opts;
  const base = new URLSearchParams({ includeConsolidated: includeConsolidated ? 'true' : 'false' });
  if (repoId) {
    base.set('repoId', repoId);
  }
  if (q) {
    base.set('q', q);
  }
  return useListQuery<Lesson>({
    queryFn: () => api.get(listUrl(`/api/v1/lessons?${base.toString()}`, page)),
    queryKey: ['lessons', includeConsolidated, opts],
  });
}

export function useDeleteLesson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ data: { deleted: boolean } }>(`/api/v1/lessons/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lessons'] });
      qc.invalidateQueries({ queryKey: ['admin-lesson-stats'] });
    },
  });
}

export function triggerRepoConsolidation(repoId: string) {
  return api.post<{ data: { workflowId: string } }>('/api/v1/lessons/consolidate', { repoId });
}

/** One lesson as the run page shows it. */
export interface RunLesson {
  id: string;
  lessonSummary: string;
  rationale: string | null;
  failureType: string | null;
  confidence: number | null;
  consolidatedAt: string | null;
  supersededAt: string | null;
  createdAt: string;
  metadata: { outcome?: unknown } | null;
}

export interface RunLessons {
  /** In the order first recalled; `lesson` is null once the lesson was deleted. */
  recalled: { lessonId: string; recalledFor: string[]; lesson: RunLesson | null }[];
  written: RunLesson[];
}

/** The lessons a run recalled into its agents' prompts and the ones it wrote. */
export function useRunLessons(runId: string, live: boolean) {
  return useQuery({
    enabled: !!runId,
    queryFn: () =>
      api.get<{ data: RunLessons }>(`/api/v1/workflow-runs/${runId}/lessons`).then((r) => r.data),
    queryKey: ['run-lessons', runId],
    // Recall happens as agents start and lessons are written at the end, so a live run is re-read.
    refetchInterval: live ? 15_000 : false,
  });
}
