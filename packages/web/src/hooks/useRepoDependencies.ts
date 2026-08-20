'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface DepNeighbor {
  id: string;
  organizationName: string | null;
  repoName: string | null;
  name: string | null;
  teamId: string;
}

export interface DepEdgeView {
  id: string;
  kind: string;
  source: string;
  status: string;
  confidence: number;
  detail: unknown;
  toRef: string | null;
  repo: DepNeighbor | null;
}

export interface RepoDependencies {
  dependsOn: DepEdgeView[];
  dependedOnBy: DepEdgeView[];
}

export interface CreateDependencyBody {
  toRepoId: string;
  kind?: string;
}

const key = (repoId: string) => ['repo-dependencies', repoId];

export function useRepoDependencies(repoId: string | null, enabled = true) {
  return useQuery({
    enabled: enabled && !!repoId,
    queryFn: () => api.get<RepoDependencies>(`/api/v1/repositories/${repoId}/dependencies`),
    queryKey: key(repoId ?? ''),
  });
}

export function useCreateRepoDependency(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateDependencyBody) =>
      api.post(`/api/v1/repositories/${repoId}/dependencies`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(repoId) }),
  });
}

export function useSetRepoDependencyStatus(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ edgeId, status }: { edgeId: string; status: 'active' | 'dismissed' }) =>
      api.patch(`/api/v1/repositories/${repoId}/dependencies/${edgeId}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(repoId) }),
  });
}

export function useDeleteRepoDependency(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (edgeId: string) =>
      api.delete(`/api/v1/repositories/${repoId}/dependencies/${edgeId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(repoId) }),
  });
}
