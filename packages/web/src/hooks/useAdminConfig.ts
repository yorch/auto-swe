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

// ── Singleton-config resource factory ──

/**
 * Every admin config is a singleton behind the same endpoint shape:
 * `GET /api/v1/admin/config/<slug>`, `PUT` to the same path, and — where the
 * integration supports it — `POST …/test` or `POST …/trigger`. Deriving the
 * path and the cache key from one slug is what keeps a resource from reading
 * one cache entry and invalidating another.
 *
 * Two GET shapes exist and both are represented: the integration configs
 * return `{ data, sources }` whole so each field can be badged db/env, while
 * the schedule and tuning configs unwrap to `data` alone.
 */
const configPath = (slug: string) => `/api/v1/admin/config/${slug}`;

/** `oauth/google` → `admin-config-oauth-google`; every other slug is flat. */
const configKey = (slug: string) => [`admin-config-${slug.replaceAll('/', '-')}`];

/** GET returning `{ data, sources }` verbatim. */
function sourcedConfigQuery<TConfig>(slug: string) {
  return () =>
    useQuery({
      queryFn: () => api.get<ConfigResponse<TConfig>>(configPath(slug)),
      queryKey: configKey(slug),
    });
}

/** GET unwrapped to `data`, for the configs that carry no source badges. */
function unwrappedConfigQuery<TConfig>(slug: string) {
  return () =>
    useQuery({
      queryFn: () => api.get<{ data: TConfig }>(configPath(slug)).then((r) => r.data),
      queryKey: configKey(slug),
    });
}

/** PUT that invalidates the matching query on success. */
function configMutation<TConfig, TInput>(slug: string) {
  return () => {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (body: TInput) => api.put<{ data: TConfig }>(configPath(slug), body),
      onSuccess: () => qc.invalidateQueries({ queryKey: configKey(slug) }),
    });
  };
}

/** POST `…/test`. The body is empty for connectors that need no probe input. */
function postConfigTest(slug: string, body: Record<string, string> = {}) {
  return api.post<{ ok: boolean; detail: string }>(`${configPath(slug)}/test`, body);
}

/** POST `…/trigger`, for the scheduled configs that can be run on demand. */
function postConfigTrigger(slug: string) {
  return api.post<{ data: { triggered: boolean } }>(`${configPath(slug)}/trigger`, {});
}

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

export const useGitHubConfig = sourcedConfigQuery<GitHubConfig>('github');

export const useUpdateGitHubConfig = configMutation<GitHubConfig, GitHubConfigInput>('github');

export const testGitHubConnection = () => postConfigTest('github');

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

export const useSlackConfig = sourcedConfigQuery<SlackConfig>('slack');

export const useUpdateSlackConfig = configMutation<SlackConfig, SlackConfigInput>('slack');

export const testSlackConnection = () => postConfigTest('slack');

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

export const useStorageConfig = sourcedConfigQuery<StorageConfig>('storage');

export const useUpdateStorageConfig = configMutation<StorageConfig, StorageConfigInput>('storage');

export const testStorageConnection = () => postConfigTest('storage');

// ── Workflow defaults ──

export interface WorkflowBudgetTier {
  inputTokens: number;
  outputTokens: number;
}

export interface WorkflowDefaultsConfig {
  branchPrefix: string | null;
  prTitleTemplate: string | null;
  prBodyTemplate: string | null;
  defaultTeamSlug: string | null;
  // Tier-2 operator knobs (GLOBAL). Present on the resolved GET payload; the
  // per-tier budgets come back nested under budgetTiers.
  budgetTiers?: Record<'STANDARD' | 'LARGE' | 'EPIC', WorkflowBudgetTier>;
  maxTddIterations?: number;
  maxEvalIterations?: number;
  workspaceMemory?: string;
  workspaceCpus?: number;
  workspacePidsLimit?: number;
  workspaceImage?: string;
  lessonRetrievalLimit?: number;
  lessonRetrievalThreshold?: number;
  evalHealthMaxFlakeRate?: number;
  evalHealthMaxStaleRate?: number;
  evalHealthMinKappa?: number;
  evalJudgeThreshold?: number;
  ciWaitMode?: 'signal' | 'poll' | null;
  ciPollIntervalSec?: number | null;
  ciPollGraceSec?: number | null;
  ciPollDeadlineSec?: number | null;
}

export interface WorkflowDefaultsInput {
  branchPrefix?: string;
  prTitleTemplate?: string;
  prBodyTemplate?: string;
  defaultTeamSlug?: string;
  // Tier-2 knobs — budgets are flat on the PUT body (nested only on read).
  budgetStandardInputTokens?: number;
  budgetStandardOutputTokens?: number;
  budgetLargeInputTokens?: number;
  budgetLargeOutputTokens?: number;
  budgetEpicInputTokens?: number;
  budgetEpicOutputTokens?: number;
  maxTddIterations?: number;
  maxEvalIterations?: number;
  workspaceMemory?: string;
  workspaceCpus?: number;
  workspacePidsLimit?: number;
  workspaceImage?: string;
  lessonRetrievalLimit?: number;
  lessonRetrievalThreshold?: number;
  evalHealthMaxFlakeRate?: number;
  evalHealthMaxStaleRate?: number;
  evalHealthMinKappa?: number;
  evalJudgeThreshold?: number;
  ciWaitMode?: 'signal' | 'poll' | null;
  ciPollIntervalSec?: number | null;
  ciPollGraceSec?: number | null;
  ciPollDeadlineSec?: number | null;
}

export const useWorkflowDefaultsConfig =
  unwrappedConfigQuery<WorkflowDefaultsConfig>('workflow-defaults');

export const useUpdateWorkflowDefaultsConfig = configMutation<
  WorkflowDefaultsConfig,
  WorkflowDefaultsInput
>('workflow-defaults');

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

export const useGoogleOAuthConfig = sourcedConfigQuery<GoogleOAuthConfig>('oauth/google');

export const useUpdateGoogleOAuthConfig = configMutation<GoogleOAuthConfig, GoogleOAuthConfigInput>(
  'oauth/google'
);

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
  allowPrivateNetwork: boolean;
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
  allowPrivateNetwork?: boolean;
}

export const useIssueTrackerConfig = sourcedConfigQuery<IssueTrackerConfig>('issue-tracker');

export const useUpdateIssueTrackerConfig = configMutation<
  IssueTrackerConfig,
  IssueTrackerConfigInput
>('issue-tracker');

export const testIssueTrackerConnection = (ticketId: string) =>
  postConfigTest('issue-tracker', { ticketId });

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
  allowPrivateNetwork: boolean;
}

export interface KnowledgeBaseConfigInput {
  provider?: KnowledgeBaseProvider | null;
  enabled?: boolean;
  baseUrl?: string | null;
  email?: string | null;
  apiToken?: string;
  spaces?: string[];
  maxPages?: number | null;
  allowPrivateNetwork?: boolean;
}

export const useKnowledgeBaseConfig = sourcedConfigQuery<KnowledgeBaseConfig>('knowledge-base');

export const useUpdateKnowledgeBaseConfig = configMutation<
  KnowledgeBaseConfig,
  KnowledgeBaseConfigInput
>('knowledge-base');

export const testKnowledgeBaseConnection = (query: string) =>
  postConfigTest('knowledge-base', { query });

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

export const useFigmaConfig = sourcedConfigQuery<FigmaConfig>('figma');

export const useUpdateFigmaConfig = configMutation<FigmaConfig, FigmaConfigInput>('figma');

export const testFigmaConnection = () => postConfigTest('figma');

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

export const useConsolidationConfig = unwrappedConfigQuery<ConsolidationConfig>('consolidation');

export const useUpdateConsolidationConfig = configMutation<
  ConsolidationConfig,
  ConsolidationConfigInput
>('consolidation');

export const triggerConsolidationNow = () => postConfigTrigger('consolidation');

// ── Re-validation schedule ──

export interface RevalidationScheduleStatus {
  exists: boolean;
  paused: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface RevalidationConfig {
  enabled: boolean;
  cronExpression: string;
  datasetSlug: string | null;
  schedule: RevalidationScheduleStatus;
}

export interface RevalidationConfigInput {
  enabled?: boolean;
  cronExpression?: string;
  datasetSlug?: string | null;
}

export const useRevalidationConfig = unwrappedConfigQuery<RevalidationConfig>('revalidation');

export const useUpdateRevalidationConfig = configMutation<
  RevalidationConfig,
  RevalidationConfigInput
>('revalidation');

export const triggerRevalidationNow = () => postConfigTrigger('revalidation');

// ── Canary routing config ──

export interface CanaryConfig {
  enabled: boolean;
  agentKey: string | null;
  candidateVersion: number | null;
  percent: number;
}

export interface CanaryConfigInput {
  enabled?: boolean;
  agentKey?: string | null;
  candidateVersion?: number | null;
  percent?: number;
}

export const useCanaryConfig = unwrappedConfigQuery<CanaryConfig>('canary');

export const useUpdateCanaryConfig = configMutation<CanaryConfig, CanaryConfigInput>('canary');

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
