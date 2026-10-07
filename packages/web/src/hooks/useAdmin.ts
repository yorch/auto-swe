'use client';

import type {
  AdminTokenSummary,
  EvalDatasetDetail,
  EvalDatasetSummary,
  EvalResultDto,
  EvalRunDto,
  EvalSignalSourceValue,
  EvalSuiteHealthDto,
  EvalTrendsDto,
} from '@auto-swe/shared/types/api';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useHasRole } from '@/hooks/useHasRole';
import { api } from '@/lib/api';
import { type DateRange, rangeKey, rangeQuery } from '@/lib/dateRange';
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
  /** The caller's own browser session. */
  current: boolean;
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

export function useAdminRevokeUserSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api
        .post<{ data: { revoked: number } }>('/api/v1/platform/sessions/revoke-user', { userId })
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-sessions'] }),
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
  /** Only on a `WorkflowRun` row: the request that run belongs to, when it has one. */
  workRequestId?: string | null;
}

export type AuditAction = 'CREATE' | 'DELETE' | 'UPDATE';

export interface AuditLogFilters {
  action?: AuditAction;
  actorId?: string;
  entityType?: string;
  /** Free text over the actor, entity type and entity id. */
  search?: string;
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

/**
 * The audit log as CSV text, under the same filters as the list. `truncated` is true when more
 * rows matched than the export carries, so the file is only the newest part of the result.
 */
export async function exportAuditLog(
  filters: AuditLogFilters
): Promise<{ csv: string; truncated: boolean }> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') {
      qs.set(key, String(value));
    }
  }
  let truncated = false;
  const csv = await api.get<string>(`/api/v1/platform/audit-log/export?${qs}`, (res) => {
    truncated = res.headers.get('x-export-truncated') === 'true';
  });
  return { csv, truncated };
}

export type SecurityEventType =
  | 'SHELL_BLOCK'
  | 'FILE_BLOCK'
  | 'CONTENT_SECURITY_BLOCK'
  | 'CONTENT_SECURITY_WARN'
  | 'CODE_SECURITY'
  | 'LLM_SUSPICIOUS'
  | 'CHANNEL_SUSPICIOUS'
  | 'MEMORY_WRITE_REFUSED'
  | 'MEMORY_RECALL_DROPPED';

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

export interface SecurityEventWindow {
  /** Inclusive start and exclusive end, as ISO instants. */
  since?: string;
  until?: string;
}

export function useSecurityEvents(
  params: SecurityEventWindow & { limit: number; offset: number; type?: SecurityEventType }
) {
  const qs = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) });
  if (params.type) {
    qs.set('type', params.type);
  }
  if (params.since) {
    qs.set('since', params.since);
  }
  if (params.until) {
    qs.set('until', params.until);
  }
  return useQuery({
    placeholderData: keepPreviousData,
    queryFn: () =>
      api.get<{ data: SecurityEvent[]; meta: { limit: number; offset: number; total: number } }>(
        `/api/v1/platform/security-events?${qs}`
      ),
    queryKey: ['security-events', params],
    refetchInterval: 30_000,
  });
}

export interface SecurityEventSummary {
  /** Per-type counts in the window. */
  counts: Record<SecurityEventType, number>;
  /** The same counts for the window of equal length just before it; absent without a window. */
  previous: Record<SecurityEventType, number> | null;
}

/** Per-type totals for a window (or all time), independent of the page shown. */
export function useSecurityEventSummary(window: SecurityEventWindow = {}) {
  const qs = new URLSearchParams();
  if (window.since && window.until) {
    qs.set('since', window.since);
    qs.set('until', window.until);
  }
  return useQuery({
    placeholderData: keepPreviousData,
    queryFn: () =>
      api
        .get<{
          data: Record<SecurityEventType, number>;
          previous?: Record<SecurityEventType, number>;
        }>(`/api/v1/platform/security-events/summary?${qs}`)
        .then((r): SecurityEventSummary => ({ counts: r.data, previous: r.previous ?? null })),
    queryKey: ['security-events', 'summary', window.since ?? null, window.until ?? null],
    // Seven counts over all of agent_traces, twice with a window: refresh rarely,
    // and on focus only once stale (the default), not every minute per open tab.
    refetchInterval: 5 * 60_000,
    staleTime: 5 * 60_000,
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

/** Which slice of usage a report covers; empty is platform-wide (ADMIN only). */
export interface UsageScope {
  teamId?: string;
  orgId?: string;
}

export interface PlatformUsage {
  byActivity: (UsageBucket & { nodeId: string })[];
  byAgent: (UsageBucket & { agentKey: string })[];
  byModel: (UsageBucket & { model: string | null })[];
  /** Null ids are spend no tenant is derivable for. */
  byOrg: (UsageBucket & { orgId: string | null; orgName: string | null })[];
  byTeam: (UsageBucket & {
    orgId: string | null;
    teamId: string | null;
    teamName: string | null;
  })[];
  /** Days each `daily` entry covers: 1, or 7 for a range over 90 days. */
  bucketDays?: 1 | 7;
  daily: {
    calls: number;
    costUsd: number;
    date: string;
    inputTokens: number;
    outputTokens: number;
  }[];
  /** The window of the same length just before this one. */
  previous: { calls: number; costUsd: number };
  scope: UsageScope;
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

/** The usage reports the caller may read (`GET /platform/usage/scopes`). */
export interface UsageScopes {
  platform: boolean;
  teams: { id: string; name: string }[];
  orgs: { id: string; name: string }[];
}

export function useUsageScopes() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: UsageScopes }>('/api/v1/platform/usage/scopes').then((r) => r.data),
    queryKey: ['usage-scopes'],
    staleTime: 5 * 60_000,
  });
}

export function usePlatformUsage(range: DateRange, scope: UsageScope = {}, enabled = true) {
  const qs = new URLSearchParams(rangeQuery(range));
  if (scope.teamId) {
    qs.set('teamId', scope.teamId);
  }
  if (scope.orgId) {
    qs.set('orgId', scope.orgId);
  }
  return useQuery({
    enabled,
    // Keep the previous window on screen while the next one loads.
    placeholderData: keepPreviousData,
    queryFn: () =>
      api.get<{ data: PlatformUsage }>(`/api/v1/platform/usage?${qs}`).then((r) => r.data),
    queryKey: ['platform-usage', rangeKey(range), scope.teamId ?? null, scope.orgId ?? null],
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

/** An organization row as the directory returns it; `role` is the viewer's own, absent for admins. */
export type DirectoryOrg = Omit<UserOrg, 'role'> & { role?: string };

/**
 * Every organization the viewer can act on: ALL active organizations for a platform admin
 * (who may manage ones they are not a member of), the viewer's own memberships otherwise.
 * Use this for organization pickers and the Organizations list; `useUserOrgs` stays the
 * "my organizations" view.
 */
export function useOrganizationDirectory() {
  const isAdmin = useHasRole('ADMIN');
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: DirectoryOrg[] }>(
          isAdmin
            ? '/api/v1/platform/organizations/budget-alerts'
            : '/api/v1/platform/organizations'
        )
        .then((r) => r.data),
    queryKey: ['user-orgs', isAdmin ? 'all' : 'mine'],
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

export interface EvalResultFilters {
  evalRunId?: string;
  scorer?: string;
  source?: EvalSignalSourceValue;
}

export function useEvalResults(filters: EvalResultFilters & { limit: number; offset: number }) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') {
      qs.set(key, String(value));
    }
  }
  return useQuery({
    placeholderData: keepPreviousData,
    queryFn: () =>
      api.get<{ data: EvalResultDto[]; meta: { limit: number; offset: number; total: number } }>(
        `/api/v1/platform/evals/results?${qs}`
      ),
    queryKey: ['eval-results', filters],
    refetchInterval: 30_000,
  });
}

export interface EvalTrendFilters {
  source?: EvalSignalSourceValue;
  /** Split each scorer's series by this column of the result rows. */
  by?: 'judgeModel' | 'agentKey' | 'runtime';
  /** Only results of runs of this workflow template. */
  templateId?: string;
}

export function useEvalTrends(range: DateRange, filters: EvalTrendFilters = {}) {
  const { by, source, templateId } = filters;
  const qs = new URLSearchParams(rangeQuery(range));
  for (const [key, value] of Object.entries({ by, source, templateId })) {
    if (value) {
      qs.set(key, value);
    }
  }
  return useQuery({
    placeholderData: keepPreviousData,
    queryFn: () =>
      api.get<{ data: EvalTrendsDto }>(`/api/v1/platform/evals/trends?${qs}`).then((r) => r.data),
    queryKey: ['eval-trends', rangeKey(range), source, by, templateId],
    // Up to one grouped query per day of the window: refresh rarely, and on
    // focus only once stale (the default), not every minute per open tab.
    refetchInterval: 5 * 60_000,
    staleTime: 5 * 60_000,
  });
}

export function useEvalSuiteHealth() {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: EvalSuiteHealthDto }>('/api/v1/platform/evals/suite-health')
        .then((r) => r.data),
    queryKey: ['eval-suite-health'],
    staleTime: 60_000,
  });
}

export function useEvalDataset(id: string | null) {
  return useQuery({
    enabled: !!id,
    queryFn: () =>
      api.get<{ data: EvalDatasetDetail }>(`/api/v1/platform/evals/${id}`).then((r) => r.data),
    queryKey: ['eval-dataset', id],
  });
}

export function useEvalRuns(datasetId: string | null, limit: number, offset: number) {
  return useQuery({
    enabled: !!datasetId,
    placeholderData: keepPreviousData,
    queryFn: () =>
      api.get<{ data: EvalRunDto[]; meta: { limit: number; offset: number; total: number } }>(
        `/api/v1/platform/evals/runs?datasetId=${datasetId}&limit=${limit}&offset=${offset}`
      ),
    queryKey: ['eval-runs', datasetId, limit, offset],
    refetchInterval: 30_000,
  });
}

/** The newest harness runs across every dataset, each carrying its dataset's name. */
export function useLatestEvalRuns(limit: number) {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: EvalRunDto[] }>(`/api/v1/platform/evals/runs?limit=${limit}`)
        .then((r) => r.data),
    queryKey: ['eval-runs', 'latest', limit],
    refetchInterval: 30_000,
  });
}

/** A running harness run is polled until it reaches a verdict. */
export function useEvalRun(id: string | null) {
  return useQuery({
    enabled: !!id,
    queryFn: () =>
      api.get<{ data: EvalRunDto }>(`/api/v1/platform/evals/runs/${id}`).then((r) => r.data),
    queryKey: ['eval-run', id],
    refetchInterval: (q) => (q.state.data?.status === 'RUNNING' ? 10_000 : false),
  });
}
