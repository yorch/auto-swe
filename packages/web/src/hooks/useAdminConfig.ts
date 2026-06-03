'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ── Masked field shape ──

export interface MaskedField {
  lastFour: string;
}

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

export function useGitHubConfig() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: GitHubConfig }>('/api/v1/admin/config/github').then((r) => r.data),
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
    queryFn: () => api.get<{ data: SlackConfig }>('/api/v1/admin/config/slack').then((r) => r.data),
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
    queryFn: () =>
      api.get<{ data: StorageConfig }>('/api/v1/admin/config/storage').then((r) => r.data),
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
  oauthClientSecret: MaskedField | null;
  requiresRestart?: boolean;
}

export interface GoogleOAuthConfigInput {
  clientId?: string;
  oauthClientSecret?: string;
}

export function useGoogleOAuthConfig() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: GoogleOAuthConfig }>('/api/v1/admin/config/oauth/google').then((r) => r.data),
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
