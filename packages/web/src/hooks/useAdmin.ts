'use client';

import type { AdminTokenSummary } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface ScannerPattern {
  createdAt: string;
  flags: string;
  id: string;
  isActive: boolean;
  isBuiltIn: boolean;
  label: string;
  origin: string | null;
  pattern: string;
  type: 'INJECTION' | 'EXFILTRATION' | 'SHELL_COMMAND' | 'CODE_SECURITY' | 'SENSITIVE_FILE';
  updatedAt: string;
}

export function useScannerPatterns() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: ScannerPattern[] }>('/api/v1/admin/scanner-patterns').then((r) => r.data),
    queryKey: ['scanner-patterns'],
  });
}

export function useCreateScannerPattern() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      flags: string;
      label: string;
      pattern: string;
      type: 'INJECTION' | 'EXFILTRATION' | 'SHELL_COMMAND' | 'CODE_SECURITY' | 'SENSITIVE_FILE';
    }) =>
      api
        .post<{ data: ScannerPattern }>('/api/v1/admin/scanner-patterns', body)
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scanner-patterns'] }),
  });
}

export function useUpdateScannerPattern() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      flags?: string;
      id: string;
      isActive?: boolean;
      label?: string;
      pattern?: string;
      type?: 'INJECTION' | 'EXFILTRATION' | 'SHELL_COMMAND' | 'CODE_SECURITY' | 'SENSITIVE_FILE';
    }) =>
      api
        .put<{ data: ScannerPattern }>(`/api/v1/admin/scanner-patterns/${id}`, body)
        .then((r) => r.data),
    onSuccess: (result) => {
      qc.setQueryData<ScannerPattern[]>(['scanner-patterns'], (old) => {
        if (!old) {
          return old;
        }
        return old.map((p) => (p.id === result.id ? result : p));
      });
    },
  });
}

export function useDeleteScannerPattern() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/scanner-patterns/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scanner-patterns'] }),
  });
}

interface AdminSessionSummary {
  id: string;
  token: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  user: { id: string; email: string };
}

export function useAdminTokens() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: AdminTokenSummary[] }>('/api/v1/admin/access-tokens').then((r) => r.data),
    queryKey: ['admin-tokens'],
    refetchInterval: 30_000,
  });
}

export function useAdminRevokeToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/access-tokens/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-tokens'] }),
  });
}

export function useAdminPruneShellAudit(days = 90) {
  return useMutation({
    mutationFn: () => api.post(`/api/v1/admin/shell-audit/prune?days=${days}`, {}),
  });
}

export function useAdminSessions() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: AdminSessionSummary[] }>('/api/v1/admin/sessions').then((r) => r.data),
    queryKey: ['admin-sessions'],
    refetchInterval: 30_000,
  });
}

export function useAdminRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-sessions'] }),
  });
}

export type SecurityEventType =
  | 'SHELL_BLOCK'
  | 'FILE_BLOCK'
  | 'CONTENT_SECURITY_BLOCK'
  | 'CONTENT_SECURITY_WARN'
  | 'CODE_SECURITY'
  | 'LLM_SUSPICIOUS'
  | 'CHANNEL_SUSPICIOUS';

export interface SecurityEvent {
  createdAt: string;
  error: string | null;
  eventType: SecurityEventType;
  externalTicketId: string | null;
  id: string;
  inputJson: unknown;
  nodeId: string;
  outputJson: unknown;
  runId: string;
  startedAt: string;
  toolName: string | null;
  workflowId: string;
  workRequestId: string | null;
}

export function useSecurityEvents(params?: {
  limit?: number;
  runId?: string;
  type?: SecurityEventType;
}) {
  const qs = new URLSearchParams();
  if (params?.limit) {
    qs.set('limit', String(params.limit));
  }
  if (params?.runId) {
    qs.set('runId', params.runId);
  }
  if (params?.type) {
    qs.set('type', params.type);
  }
  return useQuery({
    queryFn: () =>
      api.get<{ data: SecurityEvent[] }>(`/api/v1/admin/security-events?${qs}`).then((r) => r.data),
    queryKey: ['security-events', params],
    refetchInterval: 30_000,
  });
}

// ── Evals (P3 drift dashboard) ──

import type { EvalDatasetSummary, EvalResultDto } from '@auto-swe/shared/types/api';

export function useEvalDatasets() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: EvalDatasetSummary[] }>('/api/v1/admin/evals').then((r) => r.data),
    queryKey: ['eval-datasets'],
    refetchInterval: 30_000,
  });
}

export function useEvalResults(params: { source?: string; limit?: number } = {}) {
  const qs = new URLSearchParams();
  if (params.source) {
    qs.set('source', params.source);
  }
  qs.set('limit', String(params.limit ?? 200));
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: EvalResultDto[]; meta: { total: number } }>(
          `/api/v1/admin/evals/results?${qs.toString()}`
        )
        .then((r) => ({ data: r.data, meta: r.meta })),
    queryKey: ['eval-results', params],
    refetchInterval: 30_000,
  });
}
