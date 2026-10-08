'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type CiTriggerMode = 'TRIAGE_ONLY' | 'FIX';
export type CiTriggerEvent = 'push' | 'pull_request';

export interface CiTrigger {
  id: string;
  name: string;
  enabled: boolean;
  mode: CiTriggerMode;
  events: CiTriggerEvent[];
  branchPatterns: string[];
  workflowPatterns: string[];
  commentOnPullRequest: boolean;
  cooldownMinutes: number;
  maxRunsPerDay: number;
  templateId: string | null;
  template: { id: string; name: string } | null;
  createdAt: string;
}

export interface CiTriggerFire {
  id: string;
  outcome: string;
  reason: string | null;
  event: string;
  headBranch: string;
  headSha: string;
  githubRunId: string;
  runAttempt: number;
  workflowPath: string;
  pullRequestNumber: number | null;
  workRequestId: string | null;
  createdAt: string;
}

export type CiTriggerInput = Pick<
  CiTrigger,
  | 'name'
  | 'enabled'
  | 'mode'
  | 'events'
  | 'branchPatterns'
  | 'workflowPatterns'
  | 'commentOnPullRequest'
  | 'cooldownMinutes'
  | 'maxRunsPerDay'
>;

const key = (repoId: string) => ['ci-triggers', repoId];
const base = (repoId: string) => `/api/v1/repositories/${repoId}/ci-triggers`;

export function useCiTriggers(repoId: string) {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: { canManage: boolean; triggers: CiTrigger[] } }>(base(repoId))
        .then((r) => r.data),
    queryKey: key(repoId),
  });
}

export function useCiTriggerFires(repoId: string, triggerId: string | null) {
  return useQuery({
    enabled: !!triggerId,
    queryFn: () =>
      api
        .get<{ data: { fires: CiTriggerFire[] } }>(`${base(repoId)}/${triggerId}/fires?limit=20`)
        .then((r) => r.data.fires),
    queryKey: [...key(repoId), 'fires', triggerId],
  });
}

export function useCreateCiTrigger(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CiTriggerInput) => api.post(base(repoId), body),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(repoId) }),
  });
}

export function useUpdateCiTrigger(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<CiTriggerInput> & { id: string }) =>
      api.patch(`${base(repoId)}/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(repoId) }),
  });
}

export function useDeleteCiTrigger(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${base(repoId)}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(repoId) }),
  });
}
