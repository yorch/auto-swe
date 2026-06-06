'use client';

import type { LessonListItem } from '@auto-swe/shared/types/api';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useLessons() {
  return useQuery({
    queryFn: () => api.get<{ data: LessonListItem[] }>('/api/v1/lessons').then((r) => r.data),
    queryKey: ['lessons'],
  });
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
