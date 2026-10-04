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

export function useRepositories(
  opts: ListOptions & { includeInactive?: boolean; q?: string } = {}
) {
  const { includeInactive, q, ...page } = opts;
  const filters = new URLSearchParams();
  if (includeInactive) {
    filters.set('includeInactive', 'true');
  }
  if (q) {
    filters.set('q', q);
  }
  const path = `/api/v1/repositories${filters.size ? `?${filters.toString()}` : ''}`;
  return useListQuery<RepositorySummary>({
    queryFn: () => api.get(listUrl(path, page)),
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

export interface ShareTeam {
  id: string;
  name: string;
  slug: string;
}

/** Teams a repository could be shared with — its organization's, minus the owner. */
export function useShareCandidates(repoId: string, enabled: boolean) {
  return useQuery({
    enabled,
    queryFn: () =>
      api
        .get<{ data: ShareTeam[] }>(`/api/v1/repositories/${repoId}/share-candidates`)
        .then((r) => r.data),
    queryKey: ['repo-share-candidates', repoId],
  });
}

/** Replace the set of teams a repository is shared with. */
export function useSetRepoShares(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (teamIds: string[]) =>
      api.put<{ data: Array<{ team: ShareTeam }> }>(`/api/v1/repositories/${repoId}/shares`, {
        teamIds,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repositories'] }),
  });
}

export interface MyCredential {
  connectionId: string;
  lastFour: string;
  createdAt: string;
  updatedAt: string;
}

export interface MyCredentials {
  /** Whether an admin has turned per-user credentials on. */
  enabled: boolean;
  /** Hosts a saved token may be sent to — returned to platform admins only. */
  hosts?: string[];
  credentials: MyCredential[];
}

/** The caller's own saved GitHub tokens (metadata only) and the policy. */
export function useMyCredentials() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: MyCredentials }>('/api/v1/repositories/credentials/mine').then((r) => r.data),
    queryKey: ['my-repo-credentials'],
  });
}

export function useSaveMyCredential(connectionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      api.put<{ data: MyCredential & { permission: string } }>(
        `/api/v1/repositories/${connectionId}/credential`,
        { token }
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-repo-credentials'] }),
  });
}

export function useDeleteMyCredential(connectionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>(`/api/v1/repositories/${connectionId}/credential`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-repo-credentials'] }),
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
