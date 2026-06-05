'use client';

import type {
  AdminTokenSummary,
  GlobalAnalyticsResponse,
  HumanStepSummary,
  LessonListItem,
  RepositorySummary,
  SpecDiffResponse,
  StepRegistryEntry,
  TeamDetail,
  TeamSummary,
  UserSummary,
  WorkflowDetail,
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowSummary,
  WorkflowTemplateAnalytics,
  WorkflowTemplateDetail,
  WorkflowTemplateSummary,
  WorkflowTemplateVersionDetail,
} from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useWorkflows() {
  return useQuery({
    queryFn: () => api.get<{ data: WorkflowSummary[] }>('/api/v1/workflows').then((r) => r.data),
    queryKey: ['workflows'],
    refetchInterval: 10_000,
  });
}

export function useWorkflow(id: string) {
  return useQuery({
    enabled: !!id,
    queryFn: () => api.get<{ data: WorkflowDetail }>(`/api/v1/workflows/${id}`).then((r) => r.data),
    queryKey: ['workflow', id],
    refetchInterval: 5_000,
  });
}

export function useTeams() {
  return useQuery({
    queryFn: () => api.get<{ data: TeamSummary[] }>('/api/v1/teams').then((r) => r.data),
    queryKey: ['teams'],
  });
}

export function useTeam(id: string) {
  return useQuery({
    enabled: !!id,
    queryFn: () => api.get<{ data: TeamDetail }>(`/api/v1/teams/${id}`).then((r) => r.data),
    queryKey: ['team', id],
  });
}

export function useRepositories() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: RepositorySummary[] }>('/api/v1/repositories').then((r) => r.data),
    queryKey: ['repositories'],
  });
}

export function useUsers() {
  return useQuery({
    queryFn: () => api.get<{ data: UserSummary[] }>('/api/v1/users').then((r) => r.data),
    queryKey: ['users'],
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Partial<{
        isActive: boolean;
        role: 'ADMIN' | 'LEAD' | 'ENGINEER';
        slackId: string | null;
      }>;
    }) => api.patch<{ data: UserSummary }>(`/api/v1/users/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

export function useInviteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; role?: 'ADMIN' | 'LEAD' | 'ENGINEER' }) =>
      api.post<{ data: UserSummary }>('/api/v1/users/invite', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

export interface CreateUserBody {
  email: string;
  /** Omit to let the gateway auto-generate one (returned once in the response). */
  password?: string;
  role?: 'ADMIN' | 'LEAD' | 'ENGINEER';
  slackId?: string;
}

export interface CreatedUser extends UserSummary {
  /** Only present when password was auto-generated. Shown to the admin once. */
  temporaryPassword?: string;
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateUserBody) => api.post<{ data: CreatedUser }>('/api/v1/users', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

export function useLessons() {
  return useQuery({
    queryFn: () => api.get<{ data: LessonListItem[] }>('/api/v1/lessons').then((r) => r.data),
    queryKey: ['lessons'],
  });
}

// ── Workflow templates (Phase 4) ──

export function useWorkflowTemplates(teamId?: string | null) {
  return useQuery({
    queryFn: () =>
      api
        .get<{
          data: WorkflowTemplateSummary[];
        }>(`/api/v1/workflow-templates${teamId ? `?teamId=${teamId}` : ''}`)
        .then((r) => r.data),
    queryKey: ['workflow-templates', teamId ?? null],
  });
}

export function useWorkflowTemplate(id: string) {
  return useQuery({
    enabled: !!id,
    queryFn: () =>
      api
        .get<{ data: WorkflowTemplateDetail }>(`/api/v1/workflow-templates/${id}`)
        .then((r) => r.data),
    queryKey: ['workflow-template', id],
  });
}

export function useWorkflowTemplateVersion(id: string, version: number | null) {
  return useQuery({
    enabled: !!id && version !== null,
    queryFn: () =>
      api
        .get<{
          data: WorkflowTemplateVersionDetail;
        }>(`/api/v1/workflow-templates/${id}/versions/${version}`)
        .then((r) => r.data),
    queryKey: ['workflow-template-version', id, version],
  });
}

export function useTemplateRuns(id: string, limit = 50) {
  return useQuery({
    enabled: !!id,
    queryFn: () =>
      api
        .get<{
          data: WorkflowRunSummary[];
          meta: { total: number };
        }>(`/api/v1/workflow-templates/${id}/runs?limit=${limit}`)
        .then((r) => ({ data: r.data, total: r.meta.total })),
    queryKey: ['workflow-template-runs', id, limit],
    refetchInterval: 10_000,
  });
}

export function useWorkflowRun(id: string, includeTraces = true) {
  return useQuery({
    enabled: !!id,
    queryFn: () =>
      api
        .get<{ data: WorkflowRunDetail }>(
          `/api/v1/workflow-runs/${id}${includeTraces ? '?includeTraces=true' : ''}`
        )
        .then((r) => r.data),
    queryKey: ['workflow-run', id, includeTraces],
    refetchInterval: (q) => {
      const data = q.state.data as WorkflowRunDetail | undefined;
      return data?.status === 'RUNNING' ? 3_000 : 30_000;
    },
  });
}

export function useStepRegistry() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: StepRegistryEntry[] }>('/api/v1/workflow-steps/registry').then((r) => r.data),
    queryKey: ['step-registry'],
    staleTime: 5 * 60_000,
  });
}

export function useCreateWorkflowTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      description?: string;
      teamId?: string | null;
      spec: unknown;
    }) => api.post<{ data: WorkflowTemplateSummary }>('/api/v1/workflow-templates', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflow-templates'] }),
  });
}

export function useCreateWorkflowVersion(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (spec: unknown) =>
      api.post<{ data: WorkflowTemplateVersionDetail }>(
        `/api/v1/workflow-templates/${templateId}/versions`,
        { spec }
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflow-template', templateId] }),
  });
}

export function usePromoteWorkflowVersion(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (version: number) =>
      api.post(`/api/v1/workflow-templates/${templateId}/promote`, { version }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow-template', templateId] });
      qc.invalidateQueries({ queryKey: ['workflow-templates'] });
    },
  });
}

export function useUpdateWorkflowTemplate(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      body: Partial<{
        name: string;
        description: string;
        isDefault: boolean;
        status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
        experimentVersion: number | null;
        experimentSplit: number | null;
      }>
    ) =>
      api.patch<{ data: WorkflowTemplateSummary }>(
        `/api/v1/workflow-templates/${templateId}`,
        body
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow-template', templateId] });
      qc.invalidateQueries({ queryKey: ['workflow-templates'] });
    },
  });
}

export function useWorkflowSpecDiff(templateId: string, a: number | null, b: number | null) {
  return useQuery({
    enabled: !!templateId && a !== null && b !== null && a !== b,
    queryFn: () =>
      api
        .get<{ data: SpecDiffResponse }>(
          `/api/v1/workflow-templates/${templateId}/diff?a=${a}&b=${b}`
        )
        .then((r) => r.data),
    queryKey: ['workflow-template-diff', templateId, a, b],
    staleTime: 60_000,
  });
}

export function useWorkflowTemplateAnalytics(templateId: string, windowDays = 30) {
  return useQuery({
    enabled: !!templateId,
    queryFn: () =>
      api
        .get<{ data: WorkflowTemplateAnalytics }>(
          `/api/v1/workflow-templates/${templateId}/analytics?window=${windowDays}`
        )
        .then((r) => r.data),
    queryKey: ['workflow-template-analytics', templateId, windowDays],
    refetchInterval: 30_000,
  });
}

export function useGlobalAnalytics(windowDays = 30) {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: GlobalAnalyticsResponse }>(
          `/api/v1/workflow-templates/analytics?window=${windowDays}`
        )
        .then((r) => r.data),
    queryKey: ['global-analytics', windowDays],
    refetchInterval: 30_000,
  });
}

export function useCancelWorkflowRun(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`/api/v1/workflow-runs/${runId}/cancel`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow-run', runId] });
      qc.invalidateQueries({ queryKey: ['workflows'] });
    },
  });
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

export interface CreateWorkRequestBody {
  externalTicketId: string;
  description: string;
  repoIds: string[];
  budgetTier?: 'STANDARD' | 'LARGE' | 'EPIC';
}

export interface CreateWorkRequestResponse {
  data: { workflowIds: string[]; workRequestId: string };
}

export function useCreateWorkRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWorkRequestBody) =>
      api.post<CreateWorkRequestResponse>('/api/v1/work-requests', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
  });
}

// ── Repositories ──────────────────────────────────────────────────────────

export interface CreateRepoBody {
  organizationName: string;
  repoName: string;
  defaultBranch?: string;
  teamId: string;
  executorImage?: string;
  language?: string;
  description?: string;
  githubUrl?: string;
  githubApiUrl?: string;
}
export interface UpdateRepoBody {
  consolidationEnabled?: boolean;
  defaultBranch?: string;
  description?: string | null;
  executorImage?: string | null;
  isActive?: boolean;
  language?: string | null;
  teamId?: string;
  githubUrl?: string | null;
  githubApiUrl?: string | null;
}

export function useCreateRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRepoBody) =>
      api.post<{ data: RepositorySummary }>('/api/v1/repositories', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repositories'] }),
  });
}

export function useUpdateRepository(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateRepoBody) =>
      api.patch<{ data: RepositorySummary }>(`/api/v1/repositories/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repositories'] }),
  });
}

// ── Personal access tokens (user's own) ──────────────────────────────────

export interface PatSummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export interface PatCreated {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  /** Plaintext appears in the create response exactly once. */
  token: string;
}

export function usePersonalAccessTokens() {
  return useQuery({
    queryFn: () => api.get<{ data: PatSummary[] }>('/api/v1/auth/tokens').then((r) => r.data),
    queryKey: ['pats'],
  });
}

export function useCreatePat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; expiresInDays?: number }) =>
      api.post<{ data: PatCreated }>('/api/v1/auth/tokens', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pats'] }),
  });
}

export function useRevokePat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/auth/tokens/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pats'] }),
  });
}

// ── Teams (create / edit / members / shell allowlist) ────────────────────

export function useCreateTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; slug: string; description?: string }) =>
      api.post<{ data: TeamSummary }>('/api/v1/teams', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teams'] }),
  });
}

export function useUpdateTeam(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; description?: string }) =>
      api.patch<{ data: TeamSummary }>(`/api/v1/teams/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['teams'] });
      qc.invalidateQueries({ queryKey: ['team', id] });
    },
  });
}

export function useAddTeamMember(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { userId: string; role?: 'ADMIN' | 'LEAD' | 'ENGINEER' }) =>
      api.post(`/api/v1/teams/${teamId}/members`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team', teamId] }),
  });
}

export function useUpdateTeamMember(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: 'ADMIN' | 'LEAD' | 'ENGINEER' }) =>
      api.patch(`/api/v1/teams/${teamId}/members/${userId}`, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team', teamId] }),
  });
}

export function useRemoveTeamMember(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.delete(`/api/v1/teams/${teamId}/members/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team', teamId] }),
  });
}

export function useTeamShellAllowlist(teamId: string) {
  return useQuery({
    enabled: !!teamId,
    queryFn: () =>
      api
        .get<{ data: { shellImageAllowlist: string[] } }>(
          `/api/v1/teams/${teamId}/shell-image-allowlist`
        )
        .then((r) => r.data),
    queryKey: ['team-shell-allowlist', teamId],
  });
}

export function useUpdateTeamShellAllowlist(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shellImageAllowlist: string[]) =>
      api.put<{ data: { shellImageAllowlist: string[] } }>(
        `/api/v1/teams/${teamId}/shell-image-allowlist`,
        { shellImageAllowlist }
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team-shell-allowlist', teamId] }),
  });
}

export function useTeamEgressAllowlist(teamId: string) {
  return useQuery({
    enabled: !!teamId,
    queryFn: () =>
      api
        .get<{ data: { egressAllowlist: string[] } }>(`/api/v1/teams/${teamId}/egress-allowlist`)
        .then((r) => r.data),
    queryKey: ['team-egress-allowlist', teamId],
  });
}

export function useUpdateTeamEgressAllowlist(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (egressAllowlist: string[]) =>
      api.put<{ data: { egressAllowlist: string[] } }>(`/api/v1/teams/${teamId}/egress-allowlist`, {
        egressAllowlist,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team-egress-allowlist', teamId] }),
  });
}

// ── Epics ────────────────────────────────────────────────────────────────

export function useCreateEpic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { externalTicketId: string; description: string; repoIds: string[] }) =>
      api.post<{ data: { epicWorkflowId: string; workRequestId: string } }>('/api/v1/epics', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
  });
}

// ── Lessons ──────────────────────────────────────────────────────────────

export function useLessonSearch(q: string, repoId: string | null) {
  return useQuery({
    enabled: !!q && !!repoId,
    queryFn: () =>
      api
        .get<{ data: LessonListItem[] }>(
          `/api/v1/lessons/search?q=${encodeURIComponent(q)}&repoId=${repoId}`
        )
        .then((r) => r.data),
    queryKey: ['lesson-search', q, repoId],
  });
}

// ── All workflow runs (global list, not template-scoped) ─────────────────

export function useAllWorkflowRuns(
  filters: { status?: string; templateId?: string; limit?: number; offset?: number } = {}
) {
  const params = new URLSearchParams();
  if (filters.status) {
    params.set('status', filters.status);
  }
  if (filters.templateId) {
    params.set('templateId', filters.templateId);
  }
  params.set('limit', String(filters.limit ?? 50));
  params.set('offset', String(filters.offset ?? 0));
  return useQuery({
    queryFn: () =>
      api
        .get<{
          data: WorkflowRunSummary[];
          meta: { limit: number; offset: number; total: number };
        }>(`/api/v1/workflow-runs?${params.toString()}`)
        .then((r) => ({ data: r.data, meta: r.meta })),
    queryKey: ['workflow-runs', filters],
    refetchInterval: 10_000,
  });
}

// ── Human-in-the-Loop inbox ──────────────────────────────────────────────

export function useInbox() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: HumanStepSummary[] }>('/api/v1/inbox').then((r) => r.data),
    queryKey: ['inbox'],
    refetchInterval: 10_000,
  });
}

export function useRespondToHumanStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, value }: { id: string; action: string; value?: unknown }) =>
      api.post(`/api/v1/inbox/${id}/respond`, { action, value }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inbox'] });
      qc.invalidateQueries({ queryKey: ['workflow-run'] });
    },
  });
}
