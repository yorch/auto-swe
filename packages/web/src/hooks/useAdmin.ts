'use client';

import type {
  AdminTokenSummary,
  EvalDatasetSummary,
  EvalResultDto,
} from '@auto-swe/shared/types/api';
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
      api.get<{ data: ScannerPattern[] }>('/api/v1/platform/scanner-patterns').then((r) => r.data),
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
        .post<{ data: ScannerPattern }>('/api/v1/platform/scanner-patterns', body)
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
        .put<{ data: ScannerPattern }>(`/api/v1/platform/scanner-patterns/${id}`, body)
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
    mutationFn: (id: string) => api.delete(`/api/v1/platform/scanner-patterns/${id}`),
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
      api.get<{ data: AdminTokenSummary[] }>('/api/v1/platform/access-tokens').then((r) => r.data),
    queryKey: ['admin-tokens'],
    refetchInterval: 30_000,
  });
}

export function useAdminRevokeToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/platform/access-tokens/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-tokens'] }),
  });
}

export function useAdminPruneShellAudit(days = 90) {
  return useMutation({
    mutationFn: () => api.post(`/api/v1/platform/shell-audit/prune?days=${days}`, {}),
  });
}

export function useAdminSessions() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: AdminSessionSummary[] }>('/api/v1/platform/sessions').then((r) => r.data),
    queryKey: ['admin-sessions'],
    refetchInterval: 30_000,
  });
}

export function useAdminRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/platform/sessions/${id}`),
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
      api
        .get<{ data: SecurityEvent[] }>(`/api/v1/platform/security-events?${qs}`)
        .then((r) => r.data),
    queryKey: ['security-events', params],
    refetchInterval: 30_000,
  });
}

// ── Evals (P3 drift dashboard) ──

export function useEvalDatasets() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: EvalDatasetSummary[] }>('/api/v1/platform/evals').then((r) => r.data),
    queryKey: ['eval-datasets'],
    refetchInterval: 30_000,
  });
}

interface OrgMonthUsage {
  costUsdAccrued: number;
  runsCompleted: number;
  yearMonth: string;
}

export interface UserOrg {
  alert: { percent: number | null; triggered: boolean };
  budgetAlertThresholdPercent: number | null;
  currentMonthUsage: OrgMonthUsage | null;
  id: string;
  monthlyBudgetUsdCents: number | null;
  name: string;
  role: string;
  slug: string;
}

export function useUserOrgs() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: UserOrg[] }>('/api/v1/platform/organizations').then((r) => r.data),
    queryKey: ['user-orgs'],
  });
}

interface HumanErrorBaseline {
  domain: string;
  errorCount: number;
  errorRate: number;
  id: string;
  outcomeType: string | null;
  recordedAt: string;
  sampleSize: number;
}

export function useHumanErrorBaselines(orgId?: string) {
  const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : '';
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: HumanErrorBaseline[] }>(`/api/v1/human-error-baselines${qs}`)
        .then((r) => r.data),
    queryKey: ['human-error-baselines', orgId ?? 'all'],
  });
}

export function useCreateHumanErrorBaseline() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      orgId: string;
      domain: string;
      outcomeType?: string | null;
      sampleSize: number;
      errorCount: number;
    }) =>
      api
        .post<{ data: HumanErrorBaseline }>('/api/v1/human-error-baselines', body)
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['human-error-baselines'] }),
  });
}

export function useDeleteHumanErrorBaseline() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/human-error-baselines/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['human-error-baselines'] }),
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
          `/api/v1/platform/evals/results?${qs.toString()}`
        )
        .then((r) => ({ data: r.data, meta: r.meta })),
    queryKey: ['eval-results', params],
    refetchInterval: 30_000,
  });
}
