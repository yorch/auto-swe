'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ── Masked field shape ──

export interface MaskedField {
  lastFour: string;
}

// ── Source tracking ──
// 'db'  → stored in the database (configured via this UI)
// 'env' → falling back to an environment variable
// null  → not configured anywhere

export type ConfigSource = 'db' | 'env' | null;

export type ConfigSources<K extends string> = Partial<Record<K, ConfigSource>>;

export type ConfigResponse<T> = { data: T; sources: ConfigSources<keyof T & string> };

// ── GitHub config ──

export interface GitHubConfig {
  token: MaskedField | null;
  webhookSecret: MaskedField | null;
  oauthClientId: string | null;
  oauthClientSecret: MaskedField | null;
  baseUrl: string | null;
  apiUrl: string | null;
  appId: string | null;
  appClientId: string | null;
  appClientSecret: MaskedField | null;
  appPrivateKey: MaskedField | null;
  appInstallationId: string | null;
  authMode: string | null;
  requiresRestart?: boolean;
}

export interface GitHubConfigInput {
  token?: string;
  webhookSecret?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  baseUrl?: string;
  apiUrl?: string;
  appId?: string;
  appClientId?: string;
  appClientSecret?: string;
  appPrivateKey?: string;
  appInstallationId?: string;
  authMode?: string | null;
}

export function useGitHubConfig() {
  return useQuery({
    queryFn: () => api.get<ConfigResponse<GitHubConfig>>('/api/v1/admin/config/github'),
    queryKey: ['admin-config-github'],
  });
}

export function useUpdateGitHubConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GitHubConfigInput) =>
      api.put<{ data: GitHubConfig & { requiresRestart?: boolean } }>(
        '/api/v1/admin/config/github',
        body
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-config-github'] }),
  });
}

export function testGitHubConnection() {
  return api.post<{ ok: boolean; detail: string }>('/api/v1/admin/config/github/test', {});
}

// ── Slack config ──

export interface SlackConfig {
  botToken: MaskedField | null;
  clientId: string | null;
  clientSecret: MaskedField | null;
  signingSecret: MaskedField | null;
  requiresRestart?: boolean;
}

export interface SlackConfigInput {
  botToken?: string;
  clientId?: string;
  clientSecret?: string;
  signingSecret?: string;
}

export function useSlackConfig() {
  return useQuery({
    queryFn: () => api.get<ConfigResponse<SlackConfig>>('/api/v1/admin/config/slack'),
    queryKey: ['admin-config-slack'],
  });
}

export function useUpdateSlackConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SlackConfigInput) =>
      api.put<{ data: SlackConfig & { requiresRestart?: boolean } }>(
        '/api/v1/admin/config/slack',
        body
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-config-slack'] }),
  });
}

export function testSlackConnection() {
  return api.post<{ ok: boolean; detail: string }>('/api/v1/admin/config/slack/test', {});
}

// ── Storage config ──

export type StorageBackend = 'inline' | 's3';

export interface StorageConfig {
  backend: StorageBackend;
  s3Bucket: string | null;
  s3Region: string | null;
  s3Endpoint: string | null;
  s3Prefix: string | null;
  s3ForcePathStyle: boolean | null;
  awsAccessKeyId: string | null;
  awsSecretAccessKey: MaskedField | null;
}

export interface StorageConfigInput {
  backend?: StorageBackend;
  s3Bucket?: string;
  s3Region?: string;
  s3Endpoint?: string;
  s3Prefix?: string;
  s3ForcePathStyle?: boolean;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
}

export function useStorageConfig() {
  return useQuery({
    queryFn: () => api.get<ConfigResponse<StorageConfig>>('/api/v1/admin/config/storage'),
    queryKey: ['admin-config-storage'],
  });
}

export function useUpdateStorageConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: StorageConfigInput) =>
      api.put<{ data: StorageConfig }>('/api/v1/admin/config/storage', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-config-storage'] }),
  });
}

export function testStorageConnection() {
  return api.post<{ ok: boolean; detail: string }>('/api/v1/admin/config/storage/test', {});
}

// ── Workflow defaults ──

export interface WorkflowDefaultsConfig {
  branchPrefix: string | null;
  prTitleTemplate: string | null;
  prBodyTemplate: string | null;
  defaultTeamSlug: string | null;
}

export interface WorkflowDefaultsInput {
  branchPrefix?: string;
  prTitleTemplate?: string;
  prBodyTemplate?: string;
  defaultTeamSlug?: string;
}

export function useWorkflowDefaultsConfig() {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: WorkflowDefaultsConfig }>('/api/v1/admin/config/workflow-defaults')
        .then((r) => r.data),
    queryKey: ['admin-config-workflow-defaults'],
  });
}

export function useUpdateWorkflowDefaultsConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: WorkflowDefaultsInput) =>
      api.put<{ data: WorkflowDefaultsConfig }>('/api/v1/admin/config/workflow-defaults', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-config-workflow-defaults'] }),
  });
}

// ── Google OAuth config ──

export interface GoogleOAuthConfig {
  clientId: string | null;
  clientSecret: MaskedField | null;
  requiresRestart?: boolean;
}

export interface GoogleOAuthConfigInput {
  clientId?: string;
  clientSecret?: string;
}

export function useGoogleOAuthConfig() {
  return useQuery({
    queryFn: () => api.get<ConfigResponse<GoogleOAuthConfig>>('/api/v1/admin/config/oauth/google'),
    queryKey: ['admin-config-oauth-google'],
  });
}

export function useUpdateGoogleOAuthConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GoogleOAuthConfigInput) =>
      api.put<{ data: GoogleOAuthConfig & { requiresRestart?: boolean } }>(
        '/api/v1/admin/config/oauth/google',
        body
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-config-oauth-google'] }),
  });
}

// ── Issue tracker config ──

export type IssueTrackerProvider = 'jira' | 'linear' | 'github';

export interface IssueTrackerConfig {
  provider: IssueTrackerProvider | null;
  baseUrl: string | null;
  email: string | null;
  apiToken: MaskedField | null;
  instanceType: string | null;
  storyPointsFieldId: string | null;
  epicIssueType: string | null;
  storyIssueType: string | null;
  defaultProjectKey: string | null;
  webhookSecret: MaskedField | null;
  webhookTriggerStatus: string | null;
}

export interface IssueTrackerConfigInput {
  provider?: IssueTrackerProvider | null;
  baseUrl?: string | null;
  email?: string | null;
  apiToken?: string;
  instanceType?: string | null;
  storyPointsFieldId?: string | null;
  epicIssueType?: string | null;
  storyIssueType?: string | null;
  defaultProjectKey?: string | null;
  webhookSecret?: string;
  webhookTriggerStatus?: string | null;
}

export function useIssueTrackerConfig() {
  return useQuery({
    queryFn: () =>
      api.get<ConfigResponse<IssueTrackerConfig>>('/api/v1/admin/config/issue-tracker'),
    queryKey: ['admin-config-issue-tracker'],
  });
}

export function useUpdateIssueTrackerConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: IssueTrackerConfigInput) =>
      api.put<{ data: IssueTrackerConfig }>('/api/v1/admin/config/issue-tracker', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-config-issue-tracker'] }),
  });
}

export function testIssueTrackerConnection(ticketId: string) {
  return api.post<{ ok: boolean; detail: string }>('/api/v1/admin/config/issue-tracker/test', {
    ticketId,
  });
}

export function useDetectJiraFields() {
  return useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/v1/admin/config/issue-tracker/detect-fields', {
        method: 'POST',
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return res.json() as Promise<{
        fields: { id: string; name: string }[];
        storyPointsFieldId: string | null;
      }>;
    },
  });
}

// ── Knowledge base config ──

export type KnowledgeBaseProvider = 'confluence' | 'notion';

export interface KnowledgeBaseConfig {
  provider: KnowledgeBaseProvider | null;
  enabled: boolean;
  baseUrl: string | null;
  email: string | null;
  apiToken: MaskedField | null;
  spaces: string[];
  maxPages: number | null;
}

export interface KnowledgeBaseConfigInput {
  provider?: KnowledgeBaseProvider | null;
  enabled?: boolean;
  baseUrl?: string | null;
  email?: string | null;
  apiToken?: string;
  spaces?: string[];
  maxPages?: number | null;
}

export function useKnowledgeBaseConfig() {
  return useQuery({
    queryFn: () =>
      api.get<ConfigResponse<KnowledgeBaseConfig>>('/api/v1/admin/config/knowledge-base'),
    queryKey: ['admin-config-knowledge-base'],
  });
}

export function useUpdateKnowledgeBaseConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: KnowledgeBaseConfigInput) =>
      api.put<{ data: KnowledgeBaseConfig }>('/api/v1/admin/config/knowledge-base', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-config-knowledge-base'] }),
  });
}

export function testKnowledgeBaseConnection(query: string) {
  return api.post<{ ok: boolean; detail: string }>('/api/v1/admin/config/knowledge-base/test', {
    query,
  });
}

// ── Figma (design source) config ──

export interface FigmaConfig {
  enabled: boolean;
  apiToken: MaskedField | null;
  maxNodes: number | null;
}

export interface FigmaConfigInput {
  enabled?: boolean;
  apiToken?: string;
  maxNodes?: number | null;
}

export function useFigmaConfig() {
  return useQuery({
    queryFn: () => api.get<ConfigResponse<FigmaConfig>>('/api/v1/admin/config/figma'),
    queryKey: ['admin-config-figma'],
  });
}

export function useUpdateFigmaConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: FigmaConfigInput) =>
      api.put<{ data: FigmaConfig }>('/api/v1/admin/config/figma', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-config-figma'] }),
  });
}

export function testFigmaConnection() {
  return api.post<{ ok: boolean; detail: string }>('/api/v1/admin/config/figma/test', {});
}

// ── Consolidation schedule config ──

export interface ConsolidationScheduleStatus {
  exists: boolean;
  paused: boolean;
  nextRunAt: string | null;
}

export interface ConsolidationConfig {
  enabled: boolean;
  cronExpression: string;
  minClusterSize: number;
  similarityThreshold: number;
  schedule: ConsolidationScheduleStatus;
}

export interface ConsolidationConfigInput {
  enabled?: boolean;
  cronExpression?: string;
  minClusterSize?: number;
  similarityThreshold?: number;
}

export function useConsolidationConfig() {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: ConsolidationConfig }>('/api/v1/admin/config/consolidation')
        .then((r) => r.data),
    queryKey: ['admin-config-consolidation'],
  });
}

export function useUpdateConsolidationConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ConsolidationConfigInput) =>
      api.put<{ data: ConsolidationConfig }>('/api/v1/admin/config/consolidation', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-config-consolidation'] }),
  });
}

export function triggerConsolidationNow() {
  return api.post<{ data: { triggered: boolean } }>(
    '/api/v1/admin/config/consolidation/trigger',
    {}
  );
}

// ── Config audit log ──

export interface ConfigAuditEntry {
  id: string;
  entityType: string;
  entityId: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  actorId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  createdAt: string;
}

export function useConfigAuditLog(limit = 100) {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: ConfigAuditEntry[] }>(`/api/v1/admin/config/audit-log?limit=${limit}`)
        .then((r) => r.data),
    queryKey: ['admin-config-audit-log', limit],
  });
}
