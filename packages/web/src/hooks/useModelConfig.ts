'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// Per-role model config (`ModelRoleConfig`) and its UI were retired in P1.5 —
// per-agent model/skill/tool config now lives on the first-class `Agent`
// (managed at /admin/agents/library). This hook module is what remains: the
// provider-credential, embedding-config, and config-audit surfaces.

export type ConfigScope = 'GLOBAL' | 'TEAM' | 'WORKFLOW_TEMPLATE';

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
  entityType: 'Agent' | 'ProviderCredential' | 'EmbeddingConfig';
  entityId: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  actorId: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  createdAt: string;
}

export interface EmbeddingConfigRow {
  id: 'default';
  modelSpec: string;
  credentialId: string | null;
  credential?: { id: string; provider: string; lastFour: string } | null;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Provider credentials (admin, cross-scope) ──

export function useAdminCredentials() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: ProviderCredentialRow[] }>('/api/v1/admin/credentials').then((r) => r.data),
    queryKey: ['admin-credentials'],
  });
}

/// Invalidate every query that may display a credential or a row that joins
/// against one.
function invalidateCredentialQueries(qc: ReturnType<typeof useQueryClient>): void {
  qc.invalidateQueries({ queryKey: ['admin-credentials'] });
  qc.invalidateQueries({ queryKey: ['team-credentials'] });
  qc.invalidateQueries({ queryKey: ['team-accessible-credentials'] });
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
  entityType?: 'Agent' | 'ProviderCredential' | 'EmbeddingConfig';
  entityId?: string;
  limit?: number;
}) {
  const qs = new URLSearchParams();
  if (filter?.entityType) {
    qs.set('entityType', filter.entityType);
  }
  if (filter?.entityId) {
    qs.set('entityId', filter.entityId);
  }
  if (filter?.limit !== undefined) {
    qs.set('limit', String(filter.limit));
  }
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

// ── Provider credentials (team-scoped) ──

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

/// Returns this team's TEAM-scope credentials + all GLOBAL credentials —
/// the union the team owner is allowed to pin on an Agent override.
/// Backed by `GET /api/v1/teams/:id/accessible-credentials`, which is
/// gated on team-ADMIN role (not platform-ADMIN), so non-admin team owners
/// can populate the picker without 403'ing.
export function useTeamAccessibleCredentials(teamId: string) {
  return useQuery({
    enabled: Boolean(teamId),
    queryFn: () =>
      api
        .get<{ data: ProviderCredentialRow[] }>(`/api/v1/teams/${teamId}/accessible-credentials`)
        .then((r) => r.data),
    queryKey: ['team-accessible-credentials', teamId],
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

// ── Embedding config (singleton) ──

export function useEmbeddingConfig() {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: EmbeddingConfigRow | null }>('/api/v1/admin/embedding-config')
        .then((r) => r.data),
    queryKey: ['admin-embedding-config'],
  });
}

export function useUpdateEmbeddingConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { modelSpec: string; credentialId?: string | null }) =>
      api.put<{ data: EmbeddingConfigRow }>('/api/v1/admin/embedding-config', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-embedding-config'] }),
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
