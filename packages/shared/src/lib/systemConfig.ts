import { decryptSecret } from './crypto.js';

// Lazy DB access — defers prisma module load until first resolver call so that
// importing systemConfig.ts in tests doesn't trigger DATABASE_URL validation.
async function db() {
  const { prisma } = await import('../db.js');
  return prisma;
}

/// Shared resolvers for system-level config stored in the five singleton
/// tables added in migration 20260604000000. Each resolver reads from the DB
/// and falls back to the matching environment variable so that deployments
/// that haven't visited the admin UI yet continue to work unchanged.
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

  const oauthClientSecret =
    decryptOptional({
      authTag: row?.oauthClientSecretAuthTag ?? null,
      ciphertext: row?.oauthClientSecretCiphertext ?? null,
      keyVersion: row?.oauthClientSecretKeyVersion ?? null,
      nonce: row?.oauthClientSecretNonce ?? null,
    }) ??
    process.env.GITHUB_CLIENT_SECRET ??
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
    oauthClientId: row?.oauthClientId ?? process.env.GITHUB_CLIENT_ID ?? null,
    oauthClientSecret,
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

export async function resolveStorageConfig(_opts?: ResolveOpts): Promise<ResolvedStorageConfig> {
  const row = await (await db()).storageConfig.findUnique({ where: { id: 'default' } });

  const awsSecretAccessKey =
    decryptOptional({
      authTag: row?.awsSecretAccessKeyAuthTag ?? null,
      ciphertext: row?.awsSecretAccessKeyCiphertext ?? null,
      keyVersion: row?.awsSecretAccessKeyKeyVersion ?? null,
      nonce: row?.awsSecretAccessKeyNonce ?? null,
    }) ??
    process.env.AWS_SECRET_ACCESS_KEY ??
    null;

  // Trust any explicit DB value when a row exists. The PUT endpoint auto-sets
  // backend='s3' when s3Bucket is provided without an explicit backend, so a
  // partial PUT can never silently land backend='inline' in the DB anymore.
  // Fall back to the env var only when there is no DB row at all.
  const envBackend = process.env.ARTIFACT_S3_BUCKET ? 's3' : 'inline';
  const backend = (row?.backend ?? envBackend) as 'inline' | 's3';

  return {
    awsAccessKeyId: row?.awsAccessKeyId ?? process.env.AWS_ACCESS_KEY_ID ?? null,
    awsSecretAccessKey,
    backend,
    s3Bucket: row?.s3Bucket ?? process.env.ARTIFACT_S3_BUCKET ?? null,
    s3Endpoint: row?.s3Endpoint ?? process.env.ARTIFACT_S3_ENDPOINT ?? null,
    s3ForcePathStyle: row?.s3ForcePathStyle ?? process.env.ARTIFACT_S3_FORCE_PATH_STYLE === 'true',
    s3Prefix: row?.s3Prefix ?? process.env.ARTIFACT_S3_PREFIX ?? null,
    s3Region: row?.s3Region ?? process.env.ARTIFACT_S3_REGION ?? null,
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
   * reach the gateway (local dev, air-gapped). Env-driven for now (`CI_WAIT_MODE`);
   * a DB-backed admin toggle is a follow-up.
   */
  ciWaitMode: CiWaitMode;
  ciPollIntervalSec: number;
  /// After this long with no CI checks present, the poller concludes "passed".
  ciPollGraceSec: number;
  ciPollDeadlineSec: number;
}

/** Parse a positive-integer env var, falling back to `fallback` when unset/invalid. */
function envPositiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export async function resolveWorkflowDefaults(
  _opts?: ResolveOpts
): Promise<ResolvedWorkflowDefaults> {
  const row = await (await db()).workflowDefaults.findUnique({ where: { id: 'default' } });
  return {
    branchPrefix: row?.branchPrefix ?? process.env.BRANCH_PREFIX ?? 'auto',
    ciPollDeadlineSec: envPositiveInt(process.env.CI_POLL_DEADLINE_SEC, 14_400),
    ciPollGraceSec: envPositiveInt(process.env.CI_POLL_GRACE_SEC, 60),
    ciPollIntervalSec: envPositiveInt(process.env.CI_POLL_INTERVAL_SEC, 15),
    ciWaitMode: process.env.CI_WAIT_MODE === 'poll' ? 'poll' : 'signal',
    defaultTeamSlug: row?.defaultTeamSlug ?? process.env.DEFAULT_TEAM_SLUG ?? 'default',
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

// ─── Issue tracker ────────────────────────────────────────────────────────────

export type TrackerProvider = 'jira' | 'linear' | 'github';

// Import the richer config types from the integration registry and re-export them.
import type {
  ResolvedIssueTrackerConfig,
  ResolvedKnowledgeBaseConfig,
} from './integrations/registry.js';

export type { ResolvedIssueTrackerConfig, ResolvedKnowledgeBaseConfig };

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
    apiToken,
    baseUrl: row?.baseUrl ?? process.env.KB_BASE_URL ?? null,
    email: row?.email ?? process.env.KB_EMAIL ?? null,
    enabled: row?.enabled ?? false,
    maxPages: row?.maxPages ?? undefined,
    provider,
    spaces: row?.spaces?.length ? row.spaces : spacesEnv,
  };
}

// ─── Google OAuth ─────────────────────────────────────────────────────────────

export interface ResolvedGoogleOAuthConfig {
  clientId: string | null;
  clientSecret: string | null;
}

export async function resolveGoogleOAuthConfig(
  _opts?: ResolveOpts
): Promise<ResolvedGoogleOAuthConfig> {
  const row = await (await db()).googleOAuthConfig.findUnique({ where: { id: 'default' } });

  const clientSecret =
    decryptOptional({
      authTag: row?.clientSecretAuthTag ?? null,
      ciphertext: row?.clientSecretCiphertext ?? null,
      keyVersion: row?.clientSecretKeyVersion ?? null,
      nonce: row?.clientSecretNonce ?? null,
    }) ??
    process.env.GOOGLE_CLIENT_SECRET ??
    null;

  return {
    clientId: row?.clientId ?? process.env.GOOGLE_CLIENT_ID ?? null,
    clientSecret,
  };
}
