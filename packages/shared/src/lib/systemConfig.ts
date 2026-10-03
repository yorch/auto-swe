import { DOCKER_IMAGE_REF_RE } from '../workflow/shellImageAllowlist.js';
import { decryptSecret } from './crypto.js';

// Lazy DB access — defers prisma module load until first resolver call so that
// importing systemConfig.ts in tests doesn't trigger DATABASE_URL validation.
async function db() {
  const { prisma } = await import('../db.js');
  return prisma;
}

/// Shared resolvers for system-level config stored in the singleton config
/// tables (one row each, `id = 'default'`, enforced by a CHECK constraint).
/// Each resolver reads from the DB and falls back to the matching environment
/// variable so that deployments that haven't visited the admin UI yet continue
/// to work unchanged.
///
/// All resolvers are thin async functions with no in-process cache — callers
/// that need caching (worker activities, gateway request handlers) should wrap
/// in their own TTL cache. This keeps the shared package dependency-free of
/// any cache implementation.
///
/// Multi-org readiness (EVOL-3): every resolver accepts an optional
/// `ResolveOpts` whose `orgId` is RESERVED — today all six config tables are
/// singletons (`id = 'default'`) and the parameter is ignored, but new call
/// sites should thread their org context through now so introducing per-org
/// rows later is a resolver-internal change instead of a codebase-wide
/// signature break.

/** Reserved for multi-org config resolution. Ignored while config tables are singletons. */
export interface ResolveOpts {
  orgId?: string;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

type EncryptedRow = {
  ciphertext: Buffer | Uint8Array | null;
  nonce: Buffer | Uint8Array | null;
  authTag: Buffer | Uint8Array | null;
  keyVersion: number | null;
};

function decryptOptional(row: EncryptedRow): string | null {
  if (!row.ciphertext || !row.nonce || !row.authTag || row.keyVersion === null) {
    return null;
  }
  return decryptSecret({
    authTag: row.authTag,
    ciphertext: row.ciphertext,
    keyVersion: row.keyVersion,
    nonce: row.nonce,
  });
}

// ─── GitHub ───────────────────────────────────────────────────────────────────

export interface ResolvedGitHubConfig {
  /// PAT for cloning repos and creating PRs. Null if unconfigured.
  token: string | null;
  /// HMAC secret for validating inbound webhook payloads. Null if unconfigured.
  webhookSecret: string | null;
  /// GitHub OAuth app client ID for BetterAuth social sign-in.
  oauthClientId: string | null;
  /// GitHub OAuth app client secret for BetterAuth social sign-in.
  oauthClientSecret: string | null;
  /// Base URL for git clone (default: https://github.com)
  baseUrl: string;
  /// Octokit REST API base URL (default: https://api.github.com)
  apiUrl: string;
  /// GitHub App numeric ID.
  appId: string | null;
  /// GitHub App client ID.
  appClientId: string | null;
  /// GitHub App client secret.
  appClientSecret: string | null;
  /// GitHub App PEM private key for JWT signing.
  appPrivateKey: string | null;
  /// Installation ID for the GitHub App on the target org/account.
  appInstallationId: string | null;
  /// Auth mode: 'pat' | 'app' | null (null = auto: use app if fully configured, else PAT).
  authMode: string | null;
}

export async function resolveGitHubConfig(_opts?: ResolveOpts): Promise<ResolvedGitHubConfig> {
  const row = await (await db()).gitHubConfig.findUnique({ where: { id: 'default' } });

  const token =
    decryptOptional({
      authTag: row?.tokenAuthTag ?? null,
      ciphertext: row?.tokenCiphertext ?? null,
      keyVersion: row?.tokenKeyVersion ?? null,
      nonce: row?.tokenNonce ?? null,
    }) ??
    process.env.GITHUB_TOKEN ??
    null;

  const webhookSecret =
    decryptOptional({
      authTag: row?.webhookSecretAuthTag ?? null,
      ciphertext: row?.webhookSecretCiphertext ?? null,
      keyVersion: row?.webhookSecretKeyVersion ?? null,
      nonce: row?.webhookSecretNonce ?? null,
    }) ??
    process.env.GITHUB_WEBHOOK_SECRET ??
    null;

  const appClientSecret =
    decryptOptional({
      authTag: row?.appClientSecretAuthTag ?? null,
      ciphertext: row?.appClientSecretCiphertext ?? null,
      keyVersion: row?.appClientSecretKeyVersion ?? null,
      nonce: row?.appClientSecretNonce ?? null,
    }) ??
    process.env.GITHUB_APP_CLIENT_SECRET ??
    null;

  const appPrivateKey =
    decryptOptional({
      authTag: row?.appPrivateKeyAuthTag ?? null,
      ciphertext: row?.appPrivateKeyCiphertext ?? null,
      keyVersion: row?.appPrivateKeyKeyVersion ?? null,
      nonce: row?.appPrivateKeyNonce ?? null,
    }) ??
    process.env.GITHUB_APP_PRIVATE_KEY ??
    null;

  return {
    apiUrl: row?.apiUrl ?? process.env.GITHUB_API_URL ?? 'https://api.github.com',
    appClientId: row?.appClientId ?? process.env.GITHUB_APP_CLIENT_ID ?? null,
    appClientSecret,
    appId: row?.appId ?? process.env.GITHUB_APP_ID ?? null,
    appInstallationId: row?.appInstallationId ?? process.env.GITHUB_APP_INSTALLATION_ID ?? null,
    appPrivateKey,
    authMode: row?.authMode ?? process.env.GITHUB_AUTH_MODE ?? null,
    baseUrl: row?.baseUrl ?? process.env.GITHUB_URL ?? 'https://github.com',
    // Sign-in credentials are environment-only: better-auth reads them once at boot.
    oauthClientId: process.env.GITHUB_CLIENT_ID ?? null,
    oauthClientSecret: process.env.GITHUB_CLIENT_SECRET ?? null,
    token,
    webhookSecret,
  };
}

// ─── Slack ────────────────────────────────────────────────────────────────────

export interface ResolvedSlackConfig {
  clientId: string | null;
  clientSecret: string | null;
  signingSecret: string | null;
  botToken: string | null;
}

export async function resolveSlackConfig(_opts?: ResolveOpts): Promise<ResolvedSlackConfig> {
  const row = await (await db()).slackConfig.findUnique({ where: { id: 'default' } });

  const clientSecret =
    decryptOptional({
      authTag: row?.clientSecretAuthTag ?? null,
      ciphertext: row?.clientSecretCiphertext ?? null,
      keyVersion: row?.clientSecretKeyVersion ?? null,
      nonce: row?.clientSecretNonce ?? null,
    }) ??
    process.env.SLACK_CLIENT_SECRET ??
    null;

  const signingSecret =
    decryptOptional({
      authTag: row?.signingSecretAuthTag ?? null,
      ciphertext: row?.signingSecretCiphertext ?? null,
      keyVersion: row?.signingSecretKeyVersion ?? null,
      nonce: row?.signingSecretNonce ?? null,
    }) ??
    process.env.SLACK_SIGNING_SECRET ??
    null;

  const botToken =
    decryptOptional({
      authTag: row?.botTokenAuthTag ?? null,
      ciphertext: row?.botTokenCiphertext ?? null,
      keyVersion: row?.botTokenKeyVersion ?? null,
      nonce: row?.botTokenNonce ?? null,
    }) ??
    process.env.SLACK_BOT_TOKEN ??
    null;

  return {
    botToken,
    clientId: row?.clientId ?? process.env.SLACK_CLIENT_ID ?? null,
    clientSecret,
    signingSecret,
  };
}

// ─── Slack per-workspace bot token (Full multi-workspace) ──────────────────────
//
// The bot token is the ONLY per-workspace Slack secret: in a multi-workspace
// install one Slack app (one signing secret + OAuth client id/secret, all
// singleton in `SlackConfig`) is installed into N workspaces, each yielding a
// distinct `xoxb-…` bot token stored encrypted on its `SlackWorkspace` row.
// A Slack channel id (`C…`) belongs to exactly one workspace, so every post/read
// site — which always has a channel id or a workspace (`T…`) id in hand — can
// resolve the right token here, falling back to the singleton `SlackConfig`
// token so single-workspace installs (and channels not yet provisioned) keep
// working unchanged.

/** The encrypted-bot-token columns shared by `SlackWorkspace` and `SlackConfig`. */
type WorkspaceTokenRow = {
  botTokenCiphertext: Buffer | Uint8Array | null;
  botTokenNonce: Buffer | Uint8Array | null;
  botTokenAuthTag: Buffer | Uint8Array | null;
  botTokenKeyVersion: number | null;
};

const WORKSPACE_TOKEN_SELECT = {
  botTokenAuthTag: true,
  botTokenCiphertext: true,
  botTokenKeyVersion: true,
  botTokenNonce: true,
} as const;

function decryptWorkspaceToken(row: WorkspaceTokenRow | null | undefined): string | null {
  if (!row) {
    return null;
  }
  return decryptOptional({
    authTag: row.botTokenAuthTag,
    ciphertext: row.botTokenCiphertext,
    keyVersion: row.botTokenKeyVersion,
    nonce: row.botTokenNonce,
  });
}

/**
 * Resolve the bot token for posting/reading in a specific Slack channel.
 * Prefers the token of the workspace that owns the channel; falls back to the
 * singleton `SlackConfig` token (env included) when the channel isn't a
 * provisioned `SlackChannel` or its workspace never completed the install flow.
 *
 * A Slack channel id is unique within a workspace, so within one install there is
 * normally exactly one active match. Should two workspaces ever share a channel id
 * (astronomically unlikely), resolution is made deterministic by preferring the
 * row whose workspace has completed install (`installedAt` set, nulls last) — i.e.
 * the workspace that actually has a per-workspace token — rather than an arbitrary
 * first match.
 */
export async function resolveSlackBotTokenForSlackChannel(
  slackChannelId: string
): Promise<string | null> {
  const channel = await (await db()).slackChannel.findFirst({
    orderBy: { workspace: { installedAt: { nulls: 'last', sort: 'desc' } } },
    select: { workspace: { select: WORKSPACE_TOKEN_SELECT } },
    where: { isActive: true, slackChannelId },
  });
  return decryptWorkspaceToken(channel?.workspace) ?? (await resolveSlackConfig()).botToken;
}

/**
 * Resolve the bot token for a workspace by its Slack team id (`T…`). Used by the
 * surfaces that key off the workspace rather than a channel — App Home publish,
 * slash-command modals. Falls back to the singleton `SlackConfig` token.
 */
export async function resolveSlackBotTokenForWorkspace(
  slackTeamId: string
): Promise<string | null> {
  const workspace = await (await db()).slackWorkspace.findUnique({
    select: WORKSPACE_TOKEN_SELECT,
    where: { slackTeamId },
  });
  return decryptWorkspaceToken(workspace) ?? (await resolveSlackConfig()).botToken;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

export interface ResolvedStorageConfig {
  backend: 'inline' | 's3';
  s3Bucket: string | null;
  s3Region: string | null;
  s3Endpoint: string | null;
  s3Prefix: string | null;
  s3ForcePathStyle: boolean;
  awsAccessKeyId: string | null;
  awsSecretAccessKey: string | null;
}

/// Environment-only: storage is infrastructure, picked at deploy time. With no
/// bucket configured the backend is `inline` (Postgres).
export function resolveStorageConfig(_opts?: ResolveOpts): ResolvedStorageConfig {
  return {
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID ?? null,
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? null,
    backend: process.env.ARTIFACT_S3_BUCKET ? 's3' : 'inline',
    s3Bucket: process.env.ARTIFACT_S3_BUCKET ?? null,
    s3Endpoint: process.env.ARTIFACT_S3_ENDPOINT ?? null,
    s3ForcePathStyle: process.env.ARTIFACT_S3_FORCE_PATH_STYLE === 'true',
    s3Prefix: process.env.ARTIFACT_S3_PREFIX ?? null,
    s3Region: process.env.ARTIFACT_S3_REGION ?? null,
  };
}

// ─── Workflow defaults ────────────────────────────────────────────────────────

/** How the engineering workflow waits for CI after opening a PR. */
export type CiWaitMode = 'signal' | 'poll';

export interface ResolvedWorkflowDefaults {
  branchPrefix: string;
  prTitleTemplate: string;
  /// Empty string means use the worker's baked-in default body template.
  prBodyTemplate: string;
  defaultTeamSlug: string;
  /**
   * CI-wait strategy. `signal` (default) blocks for a GitHub webhook; `poll`
   * actively queries the GitHub CI APIs — use it where no inbound webhook can
   * reach the gateway (local dev, air-gapped). Stored on the `WorkflowDefaults`
   * row (edited at `/govern/workflow-defaults`); a null column falls back to `CI_WAIT_MODE`.
   */
  ciWaitMode: CiWaitMode;
  ciPollIntervalSec: number;
  /// After this long with no CI checks present, the poller concludes "passed".
  ciPollGraceSec: number;
  ciPollDeadlineSec: number;

  // ── Tier-2 operator knobs (GLOBAL) ──
  /// Per-tier token budgets keyed by BudgetTier ('STANDARD'|'LARGE'|'EPIC').
  budgetTiers: Record<string, { inputTokens: number; outputTokens: number }>;
  /// Implementer TDD refine-loop cap per run.
  maxTddIterations: number;
  /// Eval-harness attempt cap.
  maxEvalIterations: number;
  /// Lesson-retrieval relevance knobs.
  lessonRetrievalLimit: number;
  lessonRetrievalThreshold: number;
  /// Eval-suite health gate + LLM-judge thresholds.
  evalHealthMaxFlakeRate: number;
  evalHealthMaxStaleRate: number;
  evalHealthMinKappa: number;
  evalJudgeThreshold: number;
}

/** Parse a positive-integer env var, falling back to `fallback` when unset/invalid. */
function envPositiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * DB value wins; otherwise fall back to the env var. Anything other than
 * `'poll'` resolves to `'signal'` at both levels, so a typo degrades to the
 * safe webhook-driven default rather than silently enabling polling.
 */
function resolveCiWaitMode(dbValue: string | null | undefined): CiWaitMode {
  const value = dbValue ?? process.env.CI_WAIT_MODE;
  return value === 'poll' ? 'poll' : 'signal';
}

export async function resolveWorkflowDefaults(
  _opts?: ResolveOpts
): Promise<ResolvedWorkflowDefaults> {
  const row = await (await db()).workflowDefaults.findUnique({ where: { id: 'default' } });
  return {
    branchPrefix: row?.branchPrefix ?? process.env.BRANCH_PREFIX ?? 'auto',

    // Tier-2 knobs: DB value ?? the previously-hardcoded default. `??` (not `||`)
    // so a legitimately-zero override is honored where meaningful.
    budgetTiers: {
      EPIC: {
        inputTokens: row?.budgetEpicInputTokens ?? 20_000_000,
        outputTokens: row?.budgetEpicOutputTokens ?? 5_000_000,
      },
      LARGE: {
        inputTokens: row?.budgetLargeInputTokens ?? 8_000_000,
        outputTokens: row?.budgetLargeOutputTokens ?? 2_000_000,
      },
      STANDARD: {
        inputTokens: row?.budgetStandardInputTokens ?? 2_000_000,
        outputTokens: row?.budgetStandardOutputTokens ?? 500_000,
      },
    },
    // DB-primary with an env fallback, like every other integration setting.
    // A null column means "not configured here", so an existing deployment
    // driving these from the environment keeps working until an admin saves.
    ciPollDeadlineSec:
      row?.ciPollDeadlineSec ?? envPositiveInt(process.env.CI_POLL_DEADLINE_SEC, 14_400),
    ciPollGraceSec: row?.ciPollGraceSec ?? envPositiveInt(process.env.CI_POLL_GRACE_SEC, 60),
    ciPollIntervalSec:
      row?.ciPollIntervalSec ?? envPositiveInt(process.env.CI_POLL_INTERVAL_SEC, 15),
    ciWaitMode: resolveCiWaitMode(row?.ciWaitMode),
    defaultTeamSlug: row?.defaultTeamSlug ?? process.env.DEFAULT_TEAM_SLUG ?? 'default',
    evalHealthMaxFlakeRate: row?.evalHealthMaxFlakeRate ?? 0.1,
    evalHealthMaxStaleRate: row?.evalHealthMaxStaleRate ?? 0.1,
    evalHealthMinKappa: row?.evalHealthMinKappa ?? 0.4,
    evalJudgeThreshold: row?.evalJudgeThreshold ?? 0.5,
    lessonRetrievalLimit: row?.lessonRetrievalLimit ?? 5,
    lessonRetrievalThreshold: row?.lessonRetrievalThreshold ?? 0.7,
    maxEvalIterations: row?.maxEvalIterations ?? 3,
    maxTddIterations: row?.maxTddIterations ?? 5,
    prBodyTemplate: row?.prBodyTemplate ?? process.env.PR_BODY_TEMPLATE ?? '',
    prTitleTemplate:
      row?.prTitleTemplate ?? process.env.PR_TITLE_TEMPLATE ?? '[auto-swe] {{ticketId}}',
  };
}

// ─── Consolidation schedule ───────────────────────────────────────────────────

export interface ResolvedConsolidationConfig {
  /// Whether the Temporal Schedule should be active (unpaused).
  enabled: boolean;
  /// Standard cron expression (5-field) for when to run consolidation.
  cronExpression: string;
  /// Minimum cluster size below which no consolidation is performed.
  minClusterSize: number;
  /// Cosine similarity threshold for grouping lessons into a cluster.
  similarityThreshold: number;
}

export async function resolveConsolidationConfig(
  _opts?: ResolveOpts
): Promise<ResolvedConsolidationConfig> {
  const row = await (await db()).workflowDefaults.findUnique({ where: { id: 'default' } });
  return {
    cronExpression: row?.consolidationCron ?? '0 3 * * 0',
    enabled: row?.consolidationEnabled ?? true,
    minClusterSize: row?.consolidationMinClusterSize ?? 3,
    similarityThreshold: row?.consolidationSimilarityThreshold ?? 0.85,
  };
}

// ─── Eval regression schedule ─────────────────────────────────────────────────

export interface ResolvedEvalScheduleConfig {
  /// Whether the Temporal Schedule should be active (unpaused).
  enabled: boolean;
  /// Standard cron expression (5-field) for when to run the benchmark.
  cronExpression: string;
  /// Benchmark dataset slug to score on each fire.
  datasetSlug: string;
  /// Git ref scored as the candidate (typically the current line, e.g. `main`).
  candidateRef: string;
  /// Git ref scored as the baseline to compare against (e.g. `last-release`).
  baselineRef: string;
}

export async function resolveEvalScheduleConfig(
  _opts?: ResolveOpts
): Promise<ResolvedEvalScheduleConfig> {
  const row = await (await db()).workflowDefaults.findUnique({ where: { id: 'default' } });
  return {
    baselineRef: row?.evalScheduleBaselineRef ?? 'last-release',
    candidateRef: row?.evalScheduleCandidateRef ?? 'main',
    cronExpression: row?.evalScheduleCron ?? '0 7 * * *',
    datasetSlug: row?.evalScheduleDatasetSlug ?? 'swe-implementer-golden',
    // Off by default — needs a seeded dataset + a worker that can reach Docker.
    enabled: row?.evalScheduleEnabled ?? false,
  };
}

// ─── Re-validation schedule ───────────────────────────────────────────────────

export interface ResolvedRevalidationConfig {
  /// Whether the Temporal Schedule should be active (unpaused).
  enabled: boolean;
  /// Standard cron expression (5-field) for when to run re-validation.
  cronExpression: string;
  /// Optional slug substring to filter which datasets are re-validated. Null = all datasets.
  datasetSlug: string | null;
}

export async function resolveRevalidationConfig(
  _opts?: ResolveOpts
): Promise<ResolvedRevalidationConfig> {
  const row = await (await db()).workflowDefaults.findUnique({ where: { id: 'default' } });
  return {
    cronExpression: row?.revalidationCron ?? '0 5 * * 0',
    datasetSlug: row?.revalidationDatasetSlug ?? null,
    // Off by default — needs seeded EvalDatasets + a Docker-capable worker.
    enabled: row?.revalidationEnabled ?? false,
  };
}

// ─── Canary routing ───────────────────────────────────────────────────────────

export interface CanaryConfig {
  enabled: boolean;
  agentKey: string | null;
  candidateVersion: number | null;
  percent: number;
}

export async function resolveCanaryConfig(_opts?: ResolveOpts): Promise<CanaryConfig> {
  const row = await (await db()).workflowDefaults.findUnique({ where: { id: 'default' } });
  return {
    agentKey: row?.canaryAgentKey ?? null,
    candidateVersion: row?.canaryCandidateVersion ?? null,
    enabled: row?.canaryEnabled ?? false,
    percent: row?.canaryPercent ?? 0,
  };
}

// ─── Issue tracker ────────────────────────────────────────────────────────────

export type TrackerProvider = 'jira' | 'linear' | 'github';

// Import the richer config types from the integration registry and re-export them.
import type {
  ResolvedFigmaConfig,
  ResolvedIssueTrackerConfig,
  ResolvedKnowledgeBaseConfig,
} from './integrations/registry.js';

export type { ResolvedFigmaConfig, ResolvedIssueTrackerConfig, ResolvedKnowledgeBaseConfig };

function asTrackerProvider(value: string | null | undefined): TrackerProvider | null {
  return value === 'jira' || value === 'linear' || value === 'github' ? value : null;
}

export async function resolveIssueTrackerConfig(
  _opts?: ResolveOpts
): Promise<ResolvedIssueTrackerConfig> {
  const row = await (await db()).issueTrackerConfig.findUnique({ where: { id: 'default' } });

  const apiToken =
    decryptOptional({
      authTag: row?.apiTokenAuthTag ?? null,
      ciphertext: row?.apiTokenCiphertext ?? null,
      keyVersion: row?.apiTokenKeyVersion ?? null,
      nonce: row?.apiTokenNonce ?? null,
    }) ??
    process.env.TRACKER_API_TOKEN ??
    null;

  const provider = asTrackerProvider(row?.provider ?? process.env.TRACKER_PROVIDER);

  return {
    allowPrivateNetwork: row?.allowPrivateNetwork ?? false,
    apiToken,
    baseUrl: row?.baseUrl ?? process.env.TRACKER_BASE_URL ?? null,
    defaultProjectKey: row?.defaultProjectKey ?? undefined,
    email: row?.email ?? process.env.TRACKER_EMAIL ?? null,
    epicIssueType: row?.epicIssueType ?? undefined,
    instanceType: row?.instanceType ?? undefined,
    maxRetries: row?.maxRetries ?? undefined,
    provider,
    storyIssueType: row?.storyIssueType ?? undefined,
    storyPointsFieldId: row?.storyPointsFieldId ?? undefined,
    timeoutMs: row?.timeoutMs ?? undefined,
    webhookSecret:
      decryptOptional({
        authTag: row?.webhookSecretAuthTag ?? null,
        ciphertext: row?.webhookSecretCiphertext ?? null,
        keyVersion: row?.webhookSecretKeyVersion ?? null,
        nonce: row?.webhookSecretNonce ?? null,
      }) ?? undefined,
    webhookTriggerStatus: row?.webhookTriggerStatus ?? undefined,
  };
}

export async function resolveKnowledgeBaseConfig(
  _opts?: ResolveOpts
): Promise<ResolvedKnowledgeBaseConfig> {
  const row = await (await db()).knowledgeBaseConfig.findUnique({ where: { id: 'default' } });

  const apiToken =
    decryptOptional({
      authTag: row?.apiTokenAuthTag ?? null,
      ciphertext: row?.apiTokenCiphertext ?? null,
      keyVersion: row?.apiTokenKeyVersion ?? null,
      nonce: row?.apiTokenNonce ?? null,
    }) ??
    process.env.KB_API_TOKEN ??
    null;

  const provider =
    (row?.provider ?? process.env.KB_PROVIDER) === 'confluence'
      ? 'confluence'
      : (row?.provider ?? process.env.KB_PROVIDER) === 'notion'
        ? 'notion'
        : null;

  const spacesEnv = process.env.KB_SPACES
    ? process.env.KB_SPACES.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  return {
    allowPrivateNetwork: row?.allowPrivateNetwork ?? false,
    apiToken,
    baseUrl: row?.baseUrl ?? process.env.KB_BASE_URL ?? null,
    email: row?.email ?? process.env.KB_EMAIL ?? null,
    enabled: row?.enabled ?? false,
    maxPages: row?.maxPages ?? undefined,
    provider,
    spaces: row?.spaces?.length ? row.spaces : spacesEnv,
  };
}

// ─── Figma (design source) ──────────────────────────────────────────────────────

export async function resolveFigmaConfig(_opts?: ResolveOpts): Promise<ResolvedFigmaConfig> {
  const row = await (await db()).figmaConfig.findUnique({ where: { id: 'default' } });

  const apiToken =
    decryptOptional({
      authTag: row?.apiTokenAuthTag ?? null,
      ciphertext: row?.apiTokenCiphertext ?? null,
      keyVersion: row?.apiTokenKeyVersion ?? null,
      nonce: row?.apiTokenNonce ?? null,
    }) ??
    process.env.FIGMA_API_TOKEN ??
    null;

  return {
    apiToken,
    enabled: row?.enabled ?? false,
    maxNodes: row?.maxNodes ?? undefined,
  };
}

// ─── Google OAuth ─────────────────────────────────────────────────────────────

export interface ResolvedGoogleOAuthConfig {
  clientId: string | null;
  clientSecret: string | null;
}

/// Environment-only: better-auth reads these once at gateway boot, so an
/// editable copy in the database could never take effect without a restart.
export function resolveGoogleOAuthConfig(_opts?: ResolveOpts): ResolvedGoogleOAuthConfig {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID ?? null,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? null,
  };
}

// ─── Okta (enterprise SSO) ────────────────────────────────────────────────────

export interface ResolvedOktaOAuthConfig {
  /** Authorization-server issuer, trailing slash stripped. */
  issuer: string | null;
  clientId: string | null;
  clientSecret: string | null;
}

/**
 * Okta OIDC credentials for better-auth's generic-OAuth plugin. All three
 * fields must be present for the provider to register — a partially filled
 * row leaves Okta sign-in off rather than half-configured, because the
 * discovery fetch at gateway boot would fail without an issuer and the token
 * exchange would fail without a secret.
 */
export function resolveOktaOAuthConfig(_opts?: ResolveOpts): ResolvedOktaOAuthConfig {
  const rawIssuer = process.env.OKTA_ISSUER ?? null;

  return {
    clientId: process.env.OKTA_CLIENT_ID ?? null,
    clientSecret: process.env.OKTA_CLIENT_SECRET ?? null,
    // better-auth's `okta()` helper appends `/.well-known/openid-configuration`
    // to whatever it is handed; normalise here so a trailing slash in the
    // environment cannot produce a double slash in the discovery URL.
    issuer: rawIssuer ? rawIssuer.replace(/\/+$/, '') : null,
  };
}

// ─── Runtime / bootstrap configuration ────────────────────────────────────────
// These are deploy-time knobs that do not fit the DB-primary integration pattern
// (they are needed before the gateway/worker can reach the database, or they
// are public URLs used in OAuth redirects and Slack link generation). They are
// still centralized here so callers don't scatter `process.env` reads.

export function resolvePublicUrl(): string {
  return process.env.PUBLIC_URL ?? 'http://localhost:8080';
}

export function resolveWebUrl(): string {
  return process.env.WEB_URL ?? 'http://localhost:3000';
}

export function resolveTemporalAddress(): string {
  return process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
}

export function resolveOtelExporterEndpoint(): string | undefined {
  return process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
}

export function resolveOtelMetricExportInterval(): number {
  const value = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL);
  return Number.isFinite(value) && value > 0 ? value : 60_000;
}

export interface AuthEmailConfig {
  authFromEmail: string | null;
  resendApiKey: string | null;
  smtpHost: string | null;
  smtpPass: string | null;
  smtpPort: number | undefined;
  smtpUser: string | null;
}

export function resolveAuthEmailConfig(): AuthEmailConfig {
  return {
    authFromEmail: process.env.AUTH_FROM_EMAIL ?? null,
    resendApiKey: process.env.RESEND_API_KEY ?? null,
    smtpHost: process.env.SMTP_HOST ?? null,
    smtpPass: process.env.SMTP_PASS ?? null,
    smtpPort: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined,
    smtpUser: process.env.SMTP_USER ?? null,
  };
}

export interface BetterAuthBootstrapConfig {
  baseUrl: string;
  clientOrigin: string;
  secret: string;
}

export function resolveBetterAuthConfig(): BetterAuthBootstrapConfig {
  return {
    baseUrl: process.env.BETTER_AUTH_URL ?? 'http://localhost:8080',
    clientOrigin: process.env.CORS_ORIGIN?.split(',')[0]?.trim() ?? 'http://localhost:3000',
    secret: process.env.BETTER_AUTH_SECRET ?? '',
  };
}

// ─── Workspace / worker infrastructure (environment-only) ─────────────────────

export interface WorkspaceInfraConfig {
  /// Container caps for every agent workspace.
  memory: string;
  cpus: number;
  pidsLimit: number;
  /// Default base image; an explicit `image` argument to `createWorkspace` wins.
  image: string;
  /// Privileged sidecar that installs the cloud-metadata blackhole routes.
  metadataBlockImage: string;
  /// Blackhole cloud metadata IPs inside every workspace. Only the literal
  /// string `false` turns it off, so a typo cannot disable a security control.
  blockMetadata: boolean;
  /// Cap on Temporal activity tasks one worker runs at once (read at boot).
  maxConcurrentActivities: number;
  /// Per-target wall-clock budget for a scanner pattern, in milliseconds.
  regexScanBudgetMs: number;
}

/// Parses a positive integer from the environment, clamped to `[min, max]`.
/// Clamping rather than rejecting: a deployment that has always run
/// `WORKER_MAX_CONCURRENT_ACTIVITIES=2000` must not silently fall to the
/// built-in default because a ceiling was added.
function boundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  if (parsed > max) {
    console.warn(`[config] clamping ${name}=${parsed} to the maximum ${max}.`);
    return max;
  }
  return Math.max(parsed, min);
}

const warnedInvalidEnv = new Set<string>();

/// Reads a string variable that ends up inside a `docker run` command, falling
/// back to `fallback` when it is unset or fails `pattern`. These values used to
/// be validated when an admin saved them; now that nobody saves them, the check
/// moves to the read. An invalid value falls back rather than throwing, because
/// callers include scans that must never abort their activity — and says so
/// once, so a typo in the deploy config does not pass unnoticed.
function validatedEnv(name: string, fallback: string, pattern: RegExp, hint: string): string {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  if (pattern.test(raw)) {
    return raw;
  }
  if (!warnedInvalidEnv.has(name)) {
    warnedInvalidEnv.add(name);
    console.error(`[config] ignoring ${name}: not ${hint}. Using the default '${fallback}'.`);
  }
  return fallback;
}

const IMAGE_HINT = 'a valid Docker image reference';
const DOCKER_MEMORY_RE = /^\d+[bkmg]?$/i;

/// Deploy-time sizing and sidecar images for agent workspaces, plus the worker
/// and scanner bounds. These were admin-editable; they are infrastructure
/// decisions, so they now follow the host the worker runs on.
///
/// Lenient by design: this is read on the scan path, which must never throw, so
/// a bad value falls back to its default. `assertWorkspaceInfraEnv()` is the
/// strict counterpart and runs at worker boot, so a bad value is a failed
/// deploy rather than a silently different one.
export function resolveWorkspaceInfra(): WorkspaceInfraConfig {
  const cpus = Number(process.env.WORKSPACE_CPUS);
  return {
    blockMetadata: process.env.WORKSPACE_BLOCK_METADATA !== 'false',
    cpus: Number.isFinite(cpus) && cpus > 0 ? cpus : 2,
    image: validatedEnv('WORKSPACE_IMAGE', 'node:24-alpine', DOCKER_IMAGE_REF_RE, IMAGE_HINT),
    maxConcurrentActivities: boundedEnvInt('WORKER_MAX_CONCURRENT_ACTIVITIES', 10, 1, 1000),
    memory: validatedEnv(
      'WORKSPACE_MEMORY',
      '4g',
      DOCKER_MEMORY_RE,
      'a docker memory value such as 512m or 4g'
    ),
    metadataBlockImage: validatedEnv(
      'WORKSPACE_METADATA_BLOCK_IMAGE',
      'alpine:3.20',
      DOCKER_IMAGE_REF_RE,
      IMAGE_HINT
    ),
    pidsLimit: boundedEnvInt('WORKSPACE_PIDS_LIMIT', 512, 1, Number.MAX_SAFE_INTEGER),
    regexScanBudgetMs: boundedEnvInt('SCANNER_REGEX_BUDGET_MS', 250, 10, 60_000),
  };
}

/// Everything wrong with the workspace/worker environment, one message each.
/// Empty means the environment is valid. Unset or empty variables are fine —
/// they take their defaults; only a value that is *set and unusable* is a
/// problem, because that is the one the lenient resolver would otherwise
/// replace with a default without anyone noticing.
///
/// Oversized numbers are not problems: the resolver clamps them and says so.
export function validateWorkspaceInfraEnv(): string[] {
  const problems: string[] = [];
  const check = (name: string, ok: (raw: string) => boolean, expected: string) => {
    const raw = process.env[name];
    if (raw !== undefined && raw !== '' && !ok(raw)) {
      problems.push(`${name}=${JSON.stringify(raw)} is not ${expected}`);
    }
  };
  const positiveInt = (raw: string) => Number.isInteger(Number(raw)) && Number(raw) > 0;

  check(
    'WORKSPACE_MEMORY',
    (raw) => DOCKER_MEMORY_RE.test(raw),
    'a docker memory value such as 512m or 4g'
  );
  check(
    'WORKSPACE_CPUS',
    (raw) => Number.isFinite(Number(raw)) && Number(raw) > 0,
    'a positive number of cores'
  );
  check('WORKSPACE_PIDS_LIMIT', positiveInt, 'a positive integer');
  check('WORKSPACE_IMAGE', (raw) => DOCKER_IMAGE_REF_RE.test(raw), IMAGE_HINT);
  check('WORKSPACE_METADATA_BLOCK_IMAGE', (raw) => DOCKER_IMAGE_REF_RE.test(raw), IMAGE_HINT);
  // `0` or `no` would read as "off" to an operator but leave blocking on, so
  // only the two literal spellings are accepted for a security control.
  check(
    'WORKSPACE_BLOCK_METADATA',
    (raw) => raw === 'true' || raw === 'false',
    "'true' or 'false'"
  );
  check('WORKER_MAX_CONCURRENT_ACTIVITIES', positiveInt, 'a positive integer');
  check('SCANNER_REGEX_BUDGET_MS', positiveInt, 'a positive integer (milliseconds)');
  return problems;
}

/// Throws when `validateWorkspaceInfraEnv()` finds anything, naming every
/// problem at once so one failed boot is enough to fix the whole file.
export function assertWorkspaceInfraEnv(): void {
  const problems = validateWorkspaceInfraEnv();
  if (problems.length > 0) {
    throw new Error(
      `Invalid workspace configuration in the environment:\n  - ${problems.join('\n  - ')}`
    );
  }
}

// ─── Scheduled sweeps (environment-only) ──────────────────────────────────────

export interface SweepSchedule {
  enabled: boolean;
  /// Five-field cron expression, UTC.
  cronExpression: string;
}

export interface ScheduledSweepsConfig {
  /// Asks each provider which models it lists and records the unpriced ones as suggestions.
  modelDiscovery: SweepSchedule;
  /// Refreshes the cached source-control permission answers.
  repoAccess: SweepSchedule;
  /// Refreshes the repo dependency graph from manifests and git signals.
  repoDependency: SweepSchedule;
}

const CRON_RE = /^(\S+\s+){4}\S+$/;

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  return raw === 'true' ? true : raw === 'false' ? false : fallback;
}

function envCron(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw && CRON_RE.test(raw) ? raw : fallback;
}

/// The Temporal Schedules the gateway creates at boot. They are applied
/// once, at start-up, so they are environment variables: a value saved in a form
/// could not take effect without a restart, and a control that looks live but
/// is not is worse than none.
///
///   REPO_ACCESS_SYNC_ENABLED      default false — it spends API quota in
///                                 proportion to team members times repositories
///   REPO_ACCESS_SYNC_CRON         default `23 * * * *`
///   REPO_DEPENDENCY_SCAN_ENABLED  default true
///   REPO_DEPENDENCY_SCAN_CRON     default `0 4 * * *`
///   MODEL_DISCOVERY_ENABLED       default true — it only lists models
///   MODEL_DISCOVERY_CRON          default `17 3 * * *`
///
/// Lenient, like `resolveWorkspaceInfra`: a bad value falls back to its default.
/// `assertScheduledSweepsEnv()` is the strict check the gateway runs at boot.
export function resolveScheduledSweeps(): ScheduledSweepsConfig {
  return {
    modelDiscovery: {
      cronExpression: envCron('MODEL_DISCOVERY_CRON', '17 3 * * *'),
      enabled: envFlag('MODEL_DISCOVERY_ENABLED', true),
    },
    repoAccess: {
      cronExpression: envCron('REPO_ACCESS_SYNC_CRON', '23 * * * *'),
      enabled: envFlag('REPO_ACCESS_SYNC_ENABLED', false),
    },
    repoDependency: {
      cronExpression: envCron('REPO_DEPENDENCY_SCAN_CRON', '0 4 * * *'),
      enabled: envFlag('REPO_DEPENDENCY_SCAN_ENABLED', true),
    },
  };
}

/// Everything wrong with the sweep environment, one message each. Unset or
/// empty is fine; only a value that is *set and unusable* is a problem, because
/// the lenient resolver would otherwise swap it for a default unnoticed — and
/// for the `ENABLED` flags that default can be the opposite of what was meant.
export function validateScheduledSweepsEnv(): string[] {
  const problems: string[] = [];
  const check = (name: string, ok: (raw: string) => boolean, expected: string) => {
    const raw = process.env[name];
    if (raw !== undefined && raw !== '' && !ok(raw)) {
      problems.push(`${name}=${JSON.stringify(raw)} is not ${expected}`);
    }
  };
  const flag = (raw: string) => raw === 'true' || raw === 'false';
  const cron = (raw: string) => CRON_RE.test(raw.trim());
  check('REPO_ACCESS_SYNC_ENABLED', flag, "'true' or 'false'");
  check('REPO_ACCESS_SYNC_CRON', cron, 'a five-field cron expression such as "23 * * * *"');
  check('REPO_DEPENDENCY_SCAN_ENABLED', flag, "'true' or 'false'");
  check('REPO_DEPENDENCY_SCAN_CRON', cron, 'a five-field cron expression such as "0 4 * * *"');
  check('MODEL_DISCOVERY_ENABLED', flag, "'true' or 'false'");
  check('MODEL_DISCOVERY_CRON', cron, 'a five-field cron expression such as "17 3 * * *"');
  return problems;
}

/// Throws one error naming every problem, so one failed boot fixes the file.
export function assertScheduledSweepsEnv(): void {
  const problems = validateScheduledSweepsEnv();
  if (problems.length > 0) {
    throw new Error(
      `Invalid scheduled-sweep configuration in the environment:\n  - ${problems.join('\n  - ')}`
    );
  }
}
