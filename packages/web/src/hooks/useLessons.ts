'use client';

import type { LessonListItem } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  repository: { id: string; organizationName: string; repoName: string };
  workflow: { id: string; temporalWorkflowId: string; currentStatus: string } | null;
}

export function useAdminLessonStats() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: LessonRepoStats[] }>('/api/v1/lessons/stats').then((r) => r.data),
    queryKey: ['admin-lesson-stats'],
  });
}

export function useLessons(includeConsolidated = false) {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: Lesson[] }>(
          `/api/v1/lessons?includeConsolidated=${includeConsolidated ? 'true' : 'false'}`
        )
        .then((r) => r.data),
    queryKey: ['lessons', includeConsolidated],
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

export function useLessonSearch(q: string, repoId: string | null) {
  return useQuery({
    enabled: !!q && !!repoId,
    queryFn: () =>
      api
        .get<{ data: LessonListItem[] }>(
          `/api/v1/lessons/search?q=${encodeURIComponent(q)}&repoId=${repoId}`
        )
        .then((r) => r.data),
    queryKey: ['lesson-search', q, repoId],
  });
}
