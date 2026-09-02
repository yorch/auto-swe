'use client';

import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ListOptions, listUrl, useListQuery } from '@/hooks/useListQuery';
import { api } from '@/lib/api';

export interface GitHubRepoInfo {
  org: string;
  name: string;
  description: string | null;
  language: string | null;
  defaultBranch: string;
  htmlUrl: string;
  apiUrl: string;
  alreadyImported: boolean;
}

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

export interface CreateConnectionBody {
  type: string;
  name?: string;
  teamId: string;
  description?: string;
  config?: unknown;
  // git_repo only
  organizationName?: string;
  repoName?: string;
  defaultBranch?: string;
  executorImage?: string;
  language?: string;
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
  name?: string | null;
  config?: unknown;
}

export function useRepositories(opts: ListOptions = {}) {
  return useListQuery<RepositorySummary>({
    queryFn: () => api.get(listUrl('/api/v1/repositories', opts)),
    queryKey: ['repositories', opts],
  });
}

export function useCreateRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRepoBody | CreateConnectionBody) =>
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

export function useGitHubAvailableRepos(enabled = false) {
  return useQuery({
    enabled,
    queryFn: () =>
      api
        .get<{ data: GitHubRepoInfo[] }>('/api/v1/repositories/github/available')
        .then((r) => r.data),
    queryKey: ['github-available-repos'],
    staleTime: 30_000,
  });
}
