'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/// Mirrors the Prisma `AgentRole` enum.
export type ModelRole =
  | 'IMPLEMENTER'
  | 'REVIEWER'
  | 'PLANNER'
  | 'SECURITY_REVIEW'
  | 'VALIDATE_CONTEXT'
  | 'COMMIT_TO_MEMORY';

export const MODEL_ROLES: ModelRole[] = [
  'IMPLEMENTER',
  'REVIEWER',
  'PLANNER',
  'SECURITY_REVIEW',
  'VALIDATE_CONTEXT',
  'COMMIT_TO_MEMORY',
];

export type ConfigScope = 'GLOBAL' | 'TEAM' | 'WORKFLOW_TEMPLATE';

export interface ModelRoleConfigRow {
  id: string;
  role: ModelRole;
  scope: ConfigScope;
  teamId: string | null;
  workflowTemplateId: string | null;
  modelSpec: string;
  credentialId: string | null;
  credential?: { id: string; provider: string; lastFour: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderCredentialRow {
  id: string;
  provider: string;
  scope: ConfigScope;
  teamId: string | null;
  apiBase: string | null;
  lastFour: string;
  maskedKey: string;
  keyVersion: number;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigAuditRow {
  id: string;
  entityType: 'ModelRoleConfig' | 'ProviderCredential';
  entityId: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  actorId: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  createdAt: string;
}

// ── Admin (cross-scope) ──

export function useAdminModelConfigs(filter?: { scope?: ConfigScope; teamId?: string }) {
  const qs = new URLSearchParams();
  if (filter?.scope) qs.set('scope', filter.scope);
  if (filter?.teamId) qs.set('teamId', filter.teamId);
  const query = qs.toString();
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: ModelRoleConfigRow[] }>(
          `/api/v1/admin/model-config${query ? `?${query}` : ''}`
        )
        .then((r) => r.data),
    queryKey: ['admin-model-config', filter?.scope ?? null, filter?.teamId ?? null],
  });
}

export function useAdminUpsertModelConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      role: ModelRole;
      scope: ConfigScope;
      teamId?: string;
      workflowTemplateId?: string;
      modelSpec: string;
      credentialId?: string | null;
    }) => api.put<{ data: ModelRoleConfigRow }>('/api/v1/admin/model-config', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-model-config'] });
      qc.invalidateQueries({ queryKey: ['team-model-config'] });
    },
  });
}

export function useAdminDeleteModelConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/model-config/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-model-config'] });
      qc.invalidateQueries({ queryKey: ['team-model-config'] });
    },
  });
}

export function useAdminEffectiveModelConfig(args: {
  role: ModelRole;
  teamId?: string;
  workflowTemplateId?: string;
}) {
  const qs = new URLSearchParams({ role: args.role });
  if (args.teamId) qs.set('teamId', args.teamId);
  if (args.workflowTemplateId) qs.set('workflowTemplateId', args.workflowTemplateId);
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: { scope: ConfigScope | null; row: ModelRoleConfigRow | null } }>(
          `/api/v1/admin/model-config/effective?${qs}`
        )
        .then((r) => r.data),
    queryKey: [
      'admin-model-config-effective',
      args.role,
      args.teamId ?? null,
      args.workflowTemplateId ?? null,
    ],
  });
}

export function useAdminCredentials() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: ProviderCredentialRow[] }>('/api/v1/admin/credentials').then((r) => r.data),
    queryKey: ['admin-credentials'],
  });
}

/// Invalidate every query that may display a credential or a row that joins
/// against one. Model-role configs embed `credential.{lastFour, provider}`,
/// so any credential mutation also stales those.
function invalidateCredentialQueries(qc: ReturnType<typeof useQueryClient>): void {
  qc.invalidateQueries({ queryKey: ['admin-credentials'] });
  qc.invalidateQueries({ queryKey: ['team-credentials'] });
  qc.invalidateQueries({ queryKey: ['admin-model-config'] });
  qc.invalidateQueries({ queryKey: ['team-model-config'] });
  qc.invalidateQueries({ queryKey: ['admin-model-config-effective'] });
}

export function useAdminCreateCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      provider: string;
      scope: 'GLOBAL' | 'TEAM';
      teamId?: string;
      apiBase?: string;
      apiKey: string;
    }) => api.post<{ data: ProviderCredentialRow }>('/api/v1/admin/credentials', body),
    onSuccess: () => invalidateCredentialQueries(qc),
  });
}

export function useAdminUpdateCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; apiBase?: string | null; apiKey?: string }) =>
      api.put<{ data: ProviderCredentialRow }>(`/api/v1/admin/credentials/${id}`, body),
    onSuccess: () => invalidateCredentialQueries(qc),
  });
}

export function useAdminDeleteCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/credentials/${id}`),
    onSuccess: () => invalidateCredentialQueries(qc),
  });
}

export function useAdminTestCredential() {
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: { ok: boolean; status?: number; error?: string } }>(
        `/api/v1/admin/credentials/${id}/test`,
        {}
      ),
  });
}

export function useAdminConfigAuditLog(filter?: {
  entityType?: 'ModelRoleConfig' | 'ProviderCredential';
  entityId?: string;
  limit?: number;
}) {
  const qs = new URLSearchParams();
  if (filter?.entityType) qs.set('entityType', filter.entityType);
  if (filter?.entityId) qs.set('entityId', filter.entityId);
  if (filter?.limit !== undefined) qs.set('limit', String(filter.limit));
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: ConfigAuditRow[] }>(
          `/api/v1/admin/config-audit-log${qs.toString() ? `?${qs}` : ''}`
        )
        .then((r) => r.data),
    queryKey: [
      'admin-config-audit-log',
      filter?.entityType ?? null,
      filter?.entityId ?? null,
      filter?.limit ?? null,
    ],
  });
}

// ── Team-scoped ──

export function useTeamModelConfig(teamId: string) {
  return useQuery({
    enabled: Boolean(teamId),
    queryFn: () =>
      api
        .get<{ data: ModelRoleConfigRow[] }>(`/api/v1/teams/${teamId}/model-config`)
        .then((r) => r.data),
    queryKey: ['team-model-config', teamId],
  });
}

export function useTeamUpsertModelConfig(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { role: ModelRole; modelSpec: string; credentialId?: string | null }) =>
      api.put<{ data: ModelRoleConfigRow }>(`/api/v1/teams/${teamId}/model-config`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team-model-config', teamId] });
      qc.invalidateQueries({ queryKey: ['admin-model-config'] });
    },
  });
}

export function useTeamDeleteModelConfig(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (configId: string) =>
      api.delete(`/api/v1/teams/${teamId}/model-config/${configId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team-model-config', teamId] });
      qc.invalidateQueries({ queryKey: ['admin-model-config'] });
    },
  });
}

export function useTeamCredentials(teamId: string) {
  return useQuery({
    enabled: Boolean(teamId),
    queryFn: () =>
      api
        .get<{ data: ProviderCredentialRow[] }>(`/api/v1/teams/${teamId}/credentials`)
        .then((r) => r.data),
    queryKey: ['team-credentials', teamId],
  });
}

export function useTeamCreateCredential(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { provider: string; apiBase?: string; apiKey: string }) =>
      api.post<{ data: ProviderCredentialRow }>(`/api/v1/teams/${teamId}/credentials`, body),
    onSuccess: () => invalidateCredentialQueries(qc),
  });
}

export function useTeamUpdateCredential(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      credId,
      ...body
    }: {
      credId: string;
      apiBase?: string | null;
      apiKey?: string;
    }) =>
      api.put<{ data: ProviderCredentialRow }>(
        `/api/v1/teams/${teamId}/credentials/${credId}`,
        body
      ),
    onSuccess: () => invalidateCredentialQueries(qc),
  });
}

export function useTeamDeleteCredential(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (credId: string) => api.delete(`/api/v1/teams/${teamId}/credentials/${credId}`),
    onSuccess: () => invalidateCredentialQueries(qc),
  });
}

// ── Suggested model specs ──
//
// Per-provider "known good" model IDs surfaced in the UI as a dropdown. Mirrors
// the table in AGENTS.md §6. Free-text entry remains supported for everything else.
export const SUGGESTED_MODEL_SPECS: { provider: string; specs: string[] }[] = [
  {
    provider: 'anthropic',
    specs: [
      'anthropic/claude-opus-4-7',
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-haiku-4-5-20251001',
    ],
  },
  {
    provider: 'openai',
    specs: ['openai/gpt-5-5-pro', 'openai/gpt-5-5', 'openai/gpt-5'],
  },
  {
    provider: 'google',
    specs: [
      'google/gemini-2.5-pro',
      'google/gemini-2.5-flash',
      'google/gemini-3.1-flash-lite-preview',
    ],
  },
];
