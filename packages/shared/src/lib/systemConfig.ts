import { decryptSecret } from './crypto.js';

// Lazy DB access — defers prisma module load until first resolver call so that
// importing systemConfig.ts in tests doesn't trigger DATABASE_URL validation.
async function db() {
  const { prisma } = await import('../db.js');
  return prisma;
}

/// Shared resolvers for system-level config stored in the five singleton
/// tables added in migration 00000000000002. Each resolver reads from the DB
/// and falls back to the matching environment variable so that deployments
/// that haven't visited the admin UI yet continue to work unchanged.
///
/// All resolvers are thin async functions with no in-process cache — callers
/// that need caching (worker activities, gateway request handlers) should wrap
/// in their own TTL cache. This keeps the shared package dependency-free of
/// any cache implementation.

// ─── helpers ─────────────────────────────────────────────────────────────────

type EncryptedRow = {
  ciphertext: Buffer | Uint8Array | null;
  nonce: Buffer | Uint8Array | null;
  authTag: Buffer | Uint8Array | null;
  keyVersion: number | null;
};

function decryptOptional(row: EncryptedRow): string | null {
  if (!row.ciphertext || !row.nonce || !row.authTag || row.keyVersion === null) return null;
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
}

export async function resolveGitHubConfig(): Promise<ResolvedGitHubConfig> {
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

  return {
    apiUrl: row?.apiUrl ?? process.env.GITHUB_API_URL ?? 'https://api.github.com',
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

export async function resolveSlackConfig(): Promise<ResolvedSlackConfig> {
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

export async function resolveStorageConfig(): Promise<ResolvedStorageConfig> {
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

  // DB-configured backend wins; otherwise derive from env: if ARTIFACT_S3_BUCKET
  // is set we're in S3 mode even without a DB row.
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

export interface ResolvedWorkflowDefaults {
  branchPrefix: string;
  prTitleTemplate: string;
  /// Empty string means use the worker's baked-in default body template.
  prBodyTemplate: string;
  defaultTeamSlug: string;
}

export async function resolveWorkflowDefaults(): Promise<ResolvedWorkflowDefaults> {
  const row = await (await db()).workflowDefaults.findUnique({ where: { id: 'default' } });
  return {
    branchPrefix: row?.branchPrefix ?? process.env.BRANCH_PREFIX ?? 'auto',
    defaultTeamSlug: row?.defaultTeamSlug ?? process.env.DEFAULT_TEAM_SLUG ?? 'default',
    prBodyTemplate: row?.prBodyTemplate ?? process.env.PR_BODY_TEMPLATE ?? '',
    prTitleTemplate:
      row?.prTitleTemplate ?? process.env.PR_TITLE_TEMPLATE ?? '[auto-swe] {{ticketId}}',
  };
}

// ─── Google OAuth ─────────────────────────────────────────────────────────────

export interface ResolvedGoogleOAuthConfig {
  clientId: string | null;
  clientSecret: string | null;
}

export async function resolveGoogleOAuthConfig(): Promise<ResolvedGoogleOAuthConfig> {
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
