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
  consolidatedAt: string | null;
  createdAt: string;
  /**
   * Null once the repository is deleted: the lesson's `repoId` is set null with
   * it, and the lesson stays in the list until an admin deletes it.
   */
  repository: { id: string; organizationName: string; repoName: string } | null;
  workflow: { id: string; temporalWorkflowId: string; currentStatus: string } | null;
}

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
