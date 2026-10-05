'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { READINESS_KEY } from '@/hooks/useReadiness';
import { api } from '@/lib/api';

// Per-role model config (`ModelRoleConfig`) and its UI were retired in P1.5 —
// per-agent model/skill/tool config now lives on the first-class `Agent`
// (managed at /admin/agents/library). This hook module is what remains: the
// provider-credential, embedding-config, and config-audit surfaces.

export type ConfigScope = 'GLOBAL' | 'ORGANIZATION' | 'TEAM' | 'WORKFLOW_TEMPLATE';

export interface ProviderCredentialRow {
  id: string;
  provider: string;
  scope: ConfigScope;
  teamId: string | null;
  orgId: string | null;
  apiBase: string | null;
  lastFour: string;
  maskedKey: string;
  keyVersion: number;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  /** What this credential backs: agent keys pinned to it and whether embeddings use it. */
  usage?: { agents: string[]; embedding: boolean };
}

export interface ConfigAuditRow {
  id: string;
  entityType:
    | 'Agent'
    | 'ProviderCredential'
    | 'EmbeddingConfig'
    | 'ModelCatalogEntry'
    | 'ModelSuggestion';
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
      api
        .get<{ data: ProviderCredentialRow[] }>('/api/v1/platform/credentials')
        .then((r) => r.data),
    queryKey: ['admin-credentials'],
  });
}

/// Invalidate every query that may display a credential.
function invalidateCredentialQueries(qc: ReturnType<typeof useQueryClient>): void {
  qc.invalidateQueries({ queryKey: ['admin-credentials'] });
  qc.invalidateQueries({ queryKey: READINESS_KEY });
}

export function useAdminCreateCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      provider: string;
      scope: 'GLOBAL' | 'ORGANIZATION' | 'TEAM';
      teamId?: string;
      orgId?: string;
      apiBase?: string;
      apiKey: string;
    }) => api.post<{ data: ProviderCredentialRow }>('/api/v1/platform/credentials', body),
    onSuccess: () => invalidateCredentialQueries(qc),
  });
}

export function useAdminUpdateCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; apiBase?: string | null; apiKey?: string }) =>
      api.put<{ data: ProviderCredentialRow }>(`/api/v1/platform/credentials/${id}`, body),
    onSuccess: () => invalidateCredentialQueries(qc),
  });
}

export function useAdminDeleteCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/platform/credentials/${id}`),
    onSuccess: () => invalidateCredentialQueries(qc),
  });
}

export function useAdminTestCredential() {
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: { ok: boolean; status?: number; error?: string } }>(
        `/api/v1/platform/credentials/${id}/test`,
        {}
      ),
  });
}

export function useAdminConfigAuditLog(filter?: {
  entityType?:
    | 'Agent'
    | 'ProviderCredential'
    | 'EmbeddingConfig'
    | 'ModelCatalogEntry'
    | 'ModelSuggestion';
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
          `/api/v1/platform/config-audit-log${qs.toString() ? `?${qs}` : ''}`
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

// ── Embedding config (singleton) ──

export function useEmbeddingConfig() {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: EmbeddingConfigRow | null }>('/api/v1/platform/embedding-config')
        .then((r) => r.data),
    queryKey: ['admin-embedding-config'],
  });
}

export function useUpdateEmbeddingConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { modelSpec: string; credentialId?: string | null }) =>
      api.put<{ data: EmbeddingConfigRow; catalogWarnings?: string[] }>(
        '/api/v1/platform/embedding-config',
        body
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-embedding-config'] });
      qc.invalidateQueries({ queryKey: READINESS_KEY });
    },
  });
}
