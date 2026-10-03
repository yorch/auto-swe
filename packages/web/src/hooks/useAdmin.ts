'use client';

import type {
  AdminTokenSummary,
  EvalDatasetSummary,
  EvalResultDto,
} from '@auto-swe/shared/types/api';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ScannerPatternType } from '@/lib/scannerPatternTypes';

export interface ScannerPattern {
  createdAt: string;
  flags: string;
  id: string;
  isActive: boolean;
  isBuiltIn: boolean;
  label: string;
  origin: string | null;
  pattern: string;
  type: ScannerPatternType;
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
      type: ScannerPatternType;
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
      type?: ScannerPatternType;
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

// ── Platform audit log ──

export interface AuditLogRow {
  id: string;
  entityType: string;
  entityId: string;
  action: AuditAction;
  actorId: string | null;
  /** Null for a system write, or an actor whose user row no longer exists. */
  actor: { email: string; name: string | null } | null;
  beforeJson: unknown;
  afterJson: unknown;
  createdAt: string;
}

export type AuditAction = 'CREATE' | 'DELETE' | 'UPDATE';

export interface AuditLogFilters {
  action?: AuditAction;
  actorId?: string;
  entityType?: string;
  /** Inclusive UTC days, `YYYY-MM-DD`. */
  since?: string;
  until?: string;
}

export interface AuditLogPage {
  data: AuditLogRow[];
  meta: { entityTypes: string[]; limit: number; offset: number; total: number };
}

export function useAuditLog(filters: AuditLogFilters & { limit: number; offset: number }) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') {
      qs.set(key, String(value));
    }
  }
  return useQuery({
    placeholderData: keepPreviousData,
    queryFn: () => api.get<AuditLogPage>(`/api/v1/platform/audit-log?${qs}`),
    queryKey: ['audit-log', filters],
    refetchInterval: 30_000,
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
  /** Null for workflows that keep no run (evals, workflow authoring). */
  runId: string | null;
  startedAt: string | null;
  toolName: string | null;
  workflowId: string | null;
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

// ── Platform LLM usage ──

export interface UsageBucket {
  avgDurationMs: number | null;
  calls: number;
  costUsd: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
}

export interface PlatformUsage {
  byActivity: (UsageBucket & { nodeId: string })[];
  byAgent: (UsageBucket & { agentKey: string })[];
  byModel: (UsageBucket & { model: string | null })[];
  daily: {
    calls: number;
    costUsd: number;
    date: string;
    inputTokens: number;
    outputTokens: number;
  }[];
  since: string;
  /** Exclusive end of the window: the end of the current UTC day. */
  until: string;
  topRuns: {
    costUsd: number;
    externalTicketId: string | null;
    inputTokens: number;
    outputTokens: number;
    runId: string;
    startedAt: string;
    status: string;
    templateName: string;
  }[];
  totals: UsageBucket;
  /** Spend from workflows that keep no run (authoring, evals, consolidation, …). */
  unattributed: { calls: number; costUsd: number };
  windowDays: number;
}

export function usePlatformUsage(windowDays: number) {
  return useQuery({
    // Keep the previous window on screen while the next one loads.
    placeholderData: keepPreviousData,
    queryFn: () =>
      api
        .get<{ data: PlatformUsage }>(`/api/v1/platform/usage?window=${windowDays}`)
        .then((r) => r.data),
    queryKey: ['platform-usage', windowDays],
    // Not polled: each report costs a full-window scan plus one query per day,
    // and spend does not move fast enough to need it. Refetched on focus.
    staleTime: 60_000,
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
