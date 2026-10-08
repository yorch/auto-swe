'use client';

import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type CiTriggerEvent = 'push' | 'pull_request';

export interface CiTrigger {
  id: string;
  name: string;
  enabled: boolean;
  events: CiTriggerEvent[];
  branchPatterns: string[];
  workflowPatterns: string[];
  /** The template options this trigger sets; anything absent takes the template default. */
  inputs: Record<string, unknown>;
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

/** A template a trigger on this repository may start, with the options it lets one set. */
export interface CiTriggerTemplate {
  id: string;
  name: string;
  description: string;
  /** The built-in `ci-triage-and-fix`, which a trigger with no template starts. */
  builtIn: boolean;
  options: InputSchema;
}

export type CiTriggerInput = Pick<
  CiTrigger,
  | 'name'
  | 'enabled'
  | 'events'
  | 'branchPatterns'
  | 'workflowPatterns'
  | 'inputs'
  | 'cooldownMinutes'
  | 'maxRunsPerDay'
  | 'templateId'
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

export function useCiTriggerTemplates(repoId: string, enabled = true) {
  return useQuery({
    enabled,
    queryFn: () =>
      api.get<{ data: CiTriggerTemplate[] }>(`${base(repoId)}/templates`).then((r) => r.data),
    queryKey: [...key(repoId), 'templates'],
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
