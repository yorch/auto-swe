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

/** One unresolved detector finding — a dependency on a repo nobody has onboarded. */
export interface UnresolvedSuggestion {
  id: string;
  toRef: string;
  kind: string;
  source: string;
  confidence: number;
  fromRepo: DepNeighbor;
}

const key = (repoId: string) => ['repo-dependencies', repoId];
const suggestionsKey = ['repo-dependency-suggestions'];

/** Org-wide unresolved suggestions, for the "repos worth onboarding" surface. */
export function useRepoDependencySuggestions(enabled = true) {
  return useQuery({
    enabled,
    queryFn: () =>
      api
        .get<{ data: UnresolvedSuggestion[] }>('/api/v1/repositories/dependencies/unresolved')
        .then((r) => r.data),
    queryKey: suggestionsKey,
  });
}

/** Kick the detector sweep out of schedule band (ADMIN only, server-enforced). */
export function useTriggerRepoDependencyScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/api/v1/repositories/dependencies/scan', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: suggestionsKey }),
  });
}

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
