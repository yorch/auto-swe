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

// ── GitHub config ──

export interface GitHubConfig {
  token: MaskedField | null;
  webhookSecret: MaskedField | null;
  oauthClientId: string | null;
  oauthClientSecret: MaskedField | null;
  baseUrl: string | null;
  apiUrl: string | null;
  requiresRestart?: boolean;
}

export interface GitHubConfigInput {
  token?: string;
  webhookSecret?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  baseUrl?: string;
  apiUrl?: string;
}

export interface GitHubConfigResponse {
  data: GitHubConfig;
  sources: ConfigSources<keyof GitHubConfig>;
}

export function useGitHubConfig() {
  return useQuery({
    queryFn: () => api.get<GitHubConfigResponse>('/api/v1/admin/config/github'),
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

export function useTestGitHubConnection() {
  return useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; detail: string }>('/api/v1/admin/config/github/test', {}),
  });
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

export interface SlackConfigResponse {
  data: SlackConfig;
  sources: ConfigSources<keyof SlackConfig>;
}

export function useSlackConfig() {
  return useQuery({
    queryFn: () => api.get<SlackConfigResponse>('/api/v1/admin/config/slack'),
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

export function useTestSlackConnection() {
  return useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; detail: string }>('/api/v1/admin/config/slack/test', {}),
  });
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

export interface StorageConfigResponse {
  data: StorageConfig;
  sources: ConfigSources<keyof StorageConfig>;
}

export function useStorageConfig() {
  return useQuery({
    queryFn: () => api.get<StorageConfigResponse>('/api/v1/admin/config/storage'),
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

export function useTestStorageConnection() {
  return useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; detail: string }>('/api/v1/admin/config/storage/test', {}),
  });
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

export interface GoogleOAuthConfigResponse {
  data: GoogleOAuthConfig;
  sources: ConfigSources<keyof GoogleOAuthConfig>;
}

export function useGoogleOAuthConfig() {
  return useQuery({
    queryFn: () => api.get<GoogleOAuthConfigResponse>('/api/v1/admin/config/oauth/google'),
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
