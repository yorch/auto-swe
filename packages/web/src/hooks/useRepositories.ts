'use client';

import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface CreateRepoBody {
  organizationName: string;
  repoName: string;
  defaultBranch?: string;
  teamId: string;
  executorImage?: string;
  language?: string;
  description?: string;
  githubUrl?: string;
  githubApiUrl?: string;
}

export interface UpdateRepoBody {
  consolidationEnabled?: boolean;
  defaultBranch?: string;
  description?: string | null;
  executorImage?: string | null;
  isActive?: boolean;
  language?: string | null;
  teamId?: string;
  githubUrl?: string | null;
  githubApiUrl?: string | null;
}

export function useRepositories() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: RepositorySummary[] }>('/api/v1/repositories').then((r) => r.data),
    queryKey: ['repositories'],
  });
}

export function useCreateRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRepoBody) =>
      api.post<{ data: RepositorySummary }>('/api/v1/repositories', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repositories'] }),
  });
}

export function useUpdateRepository(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateRepoBody) =>
      api.patch<{ data: RepositorySummary }>(`/api/v1/repositories/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repositories'] }),
  });
}
