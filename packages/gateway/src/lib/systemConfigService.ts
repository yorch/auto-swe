import type { PrismaClient } from '@auto-swe/shared';
import { decryptSecret, encryptSecret } from '@auto-swe/shared/lib/crypto';
import {
  resolveGitHubConfig,
  resolveIssueTrackerConfig,
  resolveKnowledgeBaseConfig,
  resolveSlackConfig,
  resolveStorageConfig,
} from '@auto-swe/shared/lib/systemConfig';
import { WebClient } from '@slack/web-api';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Service for the singleton system-config tables (GitHub, Slack, Storage,
 * WorkflowDefaults, GoogleOAuth, Tracker). Each section follows the same
 * pattern: a masked read view (`get*Config`), a partial update that seals
 * secrets into AES-GCM envelope columns (`update*Config`), and — where
 * meaningful — a live connection test. Secret fields are write-only:
 * reads return `lastFour` only, never the plaintext.
 *
 * Functions take `prisma` as an argument — no Fastify coupling — so routes
 * stay thin and the logic is unit-testable.
 */

// Fixed UUIDs for the singleton system-config entities.
// Used as entityId in ConfigAuditLog (which requires a UUID PK) since the
// config tables use the string 'default' as their PK.
export const SYSTEM_CONFIG_IDS = {
  github: '00000000-0000-0000-0001-000000000001',
  googleOAuth: '00000000-0000-0000-0001-000000000005',
  knowledgeBase: '00000000-0000-0000-0001-000000000007',
  slack: '00000000-0000-0000-0001-000000000002',
  storage: '00000000-0000-0000-0001-000000000003',
  tracker: '00000000-0000-0000-0001-000000000006',
  workflowDefaults: '00000000-0000-0000-0001-000000000004',
} as const;

// ─── helpers ──────────────────────────────────────────────────────────────────

/// Encrypts `plaintext` and writes the five AES-GCM envelope columns into
/// `data` using `prefix` as the field-name prefix (e.g. prefix='token' →
/// data.tokenCiphertext, data.tokenNonce, …).  No-ops when plaintext is falsy.
function sealInto(
  data: Record<string, unknown>,
  prefix: string,
  plaintext: string | undefined
): void {
  if (!plaintext) {
    return;
  }
  const { authTag, ciphertext, keyVersion, lastFour, nonce } = encryptSecret(plaintext);
  data[`${prefix}Ciphertext`] = ciphertext;
  data[`${prefix}Nonce`] = nonce;
  data[`${prefix}AuthTag`] = authTag;
  data[`${prefix}KeyVersion`] = keyVersion;
  data[`${prefix}LastFour`] = lastFour;
}

/// Returns a lastFour-only object when ciphertext exists, null otherwise.
function maskedSecret(lastFour: string | null | undefined) {
  return lastFour ? { lastFour } : null;
}

/// Returns the source of a config value: 'db' when the DB row has the value,
/// 'env' when it falls back to an environment variable, null when absent.
type ConfigSource = 'db' | 'env' | null;
function src(dbPresent: boolean, envKey: string): ConfigSource {
  if (dbPresent) {
    return 'db';
  }
  if (process.env[envKey]) {
    return 'env';
  }
  return null;
}

/// Builds the list of field names that were provided in a PUT body.
/// Pairs are [fieldName, value]; undefined means not sent (skip); null means
/// explicitly cleared (record in audit log); '' means empty secret input (skip).
function changedKeys(pairs: [string, unknown][]): string[] {
  return pairs.filter(([, v]) => v !== undefined && v !== '').map(([k]) => k);
}

/// Writes a ConfigAuditLog entry for a system-config change. Best-effort —
/// an audit failure is logged but never fails the config write itself.
export async function writeSystemConfigAudit(
  prisma: PrismaClient,
  log: FastifyBaseLogger,
  args: {
    action: 'CREATE' | 'UPDATE';
    actorId: string;
    afterJson: Record<string, unknown>;
    entityId: string;
    entityType: string;
  }
): Promise<void> {
  try {
    await prisma.configAuditLog.create({
      data: {
        action: args.action,
        actorId: args.actorId,
        afterJson: args.afterJson as never,
        entityId: args.entityId,
        entityType: args.entityType,
      },
    });
  } catch (auditErr) {
    log.warn({ err: auditErr }, `Failed to write ${args.entityType} audit log`);
  }
}

type ConfigUpdateResult = {
  /// Audit payload (only meaningful when changedFields is non-empty).
  auditAfterJson: Record<string, unknown>;
  changedFields: string[];
  /// Masked response body for the PUT route.
  data: Record<string, unknown>;
  /// Whether a row existed before this write (CREATE vs UPDATE audit action).
  existed: boolean;
};

// ─── GitHub ───────────────────────────────────────────────────────────────────

type GitHubConfigRow = NonNullable<Awaited<ReturnType<PrismaClient['gitHubConfig']['findUnique']>>>;

export type GitHubConfigInput = {
  apiUrl?: string | null;
  appClientId?: string | null;
  appClientSecret?: string;
  appId?: string | null;
  appInstallationId?: string | null;
  appPrivateKey?: string;
  authMode?: 'auto' | 'pat' | 'app' | null;
  baseUrl?: string | null;
  oauthClientId?: string | null;
  oauthClientSecret?: string;
  token?: string;
  webhookSecret?: string;
};

function githubData(row: GitHubConfigRow | null) {
  return {
    apiUrl: row?.apiUrl ?? null,
    appClientId: row?.appClientId ?? null,
    appClientSecret: maskedSecret(row?.appClientSecretLastFour),
    appId: row?.appId ?? null,
    appInstallationId: row?.appInstallationId ?? null,
    appPrivateKey: maskedSecret(row?.appPrivateKeyLastFour),
    authMode: row?.authMode ?? null,
    baseUrl: row?.baseUrl ?? null,
    oauthClientId: row?.oauthClientId ?? null,
    oauthClientSecret: maskedSecret(row?.oauthClientSecretLastFour),
    token: maskedSecret(row?.tokenLastFour),
    webhookSecret: maskedSecret(row?.webhookSecretLastFour),
  };
}

export async function getGitHubConfig(prisma: PrismaClient) {
  const row = await prisma.gitHubConfig.findUnique({ where: { id: 'default' } });
  return {
    data: githubData(row),
    sources: {
      apiUrl: src(!!row?.apiUrl, 'GITHUB_API_URL'),
      appClientId: src(!!row?.appClientId, 'GITHUB_APP_CLIENT_ID'),
      appClientSecret: src(!!row?.appClientSecretCiphertext, 'GITHUB_APP_CLIENT_SECRET'),
      appId: src(!!row?.appId, 'GITHUB_APP_ID'),
      appInstallationId: src(!!row?.appInstallationId, 'GITHUB_APP_INSTALLATION_ID'),
      appPrivateKey: src(!!row?.appPrivateKeyCiphertext, 'GITHUB_APP_PRIVATE_KEY'),
      authMode: src(!!row?.authMode, 'GITHUB_AUTH_MODE'),
      baseUrl: src(!!row?.baseUrl, 'GITHUB_URL'),
      oauthClientId: src(!!row?.oauthClientId, 'GITHUB_CLIENT_ID'),
      oauthClientSecret: src(!!row?.oauthClientSecretCiphertext, 'GITHUB_CLIENT_SECRET'),
      token: src(!!row?.tokenCiphertext, 'GITHUB_TOKEN'),
      webhookSecret: src(!!row?.webhookSecretCiphertext, 'GITHUB_WEBHOOK_SECRET'),
    },
  };
}

export async function updateGitHubConfig(
  prisma: PrismaClient,
  body: GitHubConfigInput
): Promise<ConfigUpdateResult> {
  const {
    token,
    webhookSecret,
    oauthClientSecret,
    oauthClientId,
    apiUrl,
    baseUrl,
    appId,
    appClientId,
    appClientSecret,
    appPrivateKey,
    appInstallationId,
    authMode,
  } = body;

  const existing = await prisma.gitHubConfig.findUnique({ where: { id: 'default' } });

  const data: Record<string, unknown> = {};
  if (apiUrl !== undefined) {
    data.apiUrl = apiUrl;
  }
  if (baseUrl !== undefined) {
    data.baseUrl = baseUrl;
  }
  if (oauthClientId !== undefined) {
    data.oauthClientId = oauthClientId;
  }
  if (appId !== undefined) {
    data.appId = appId;
  }
  if (appClientId !== undefined) {
    data.appClientId = appClientId;
  }
  if (appInstallationId !== undefined) {
    data.appInstallationId = appInstallationId;
  }
  if (authMode !== undefined) {
    data.authMode = authMode;
  }

  sealInto(data, 'token', token);
  sealInto(data, 'webhookSecret', webhookSecret);
  sealInto(data, 'oauthClientSecret', oauthClientSecret);
  sealInto(data, 'appClientSecret', appClientSecret);
  sealInto(data, 'appPrivateKey', appPrivateKey);

  const row = await prisma.gitHubConfig.upsert({
    create: { id: 'default', ...data },
    update: data,
    where: { id: 'default' },
  });

  const changedFields = changedKeys([
    ['token', token],
    ['webhookSecret', webhookSecret],
    ['oauthClientId', oauthClientId],
    ['oauthClientSecret', oauthClientSecret],
    ['apiUrl', apiUrl],
    ['baseUrl', baseUrl],
    ['appId', appId],
    ['appClientId', appClientId],
    ['appClientSecret', appClientSecret],
    ['appPrivateKey', appPrivateKey],
    ['appInstallationId', appInstallationId],
    ['authMode', authMode],
  ]);

  return {
    auditAfterJson: {
      apiUrl: row.apiUrl,
      appClientId: row.appClientId,
      appId: row.appId,
      appInstallationId: row.appInstallationId,
      authMode: row.authMode,
      baseUrl: row.baseUrl,
      changedFields,
      oauthClientId: row.oauthClientId,
    },
    changedFields,
    data: {
      ...githubData(row),
      requiresRestart: !!(oauthClientId !== undefined || oauthClientSecret),
    },
    existed: !!existing,
  };
}

export async function testGitHubConnection(): Promise<{ detail: string; ok: boolean }> {
  const config = await resolveGitHubConfig();

  const appConfigured = config.appId && config.appPrivateKey && config.appInstallationId;
  const mode = config.authMode ?? 'auto';
  const useApp = mode === 'app' || (mode === 'auto' && appConfigured);

  if (useApp) {
    return {
      detail: `GitHub App configured (id: ${config.appId}, installation: ${config.appInstallationId}). Start the worker to validate token generation.`,
      ok: true,
    };
  }

  if (!config.token) {
    return { detail: 'No GitHub token configured.', ok: false };
  }
  try {
    const res = await fetch(`${config.apiUrl}/user`, {
      headers: {
        Authorization: `Bearer ${config.token}`,
        'User-Agent': 'auto-swe/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      return {
        detail: `GitHub API returned ${res.status}: ${body.message ?? res.statusText}`,
        ok: false,
      };
    }
    const user = (await res.json()) as { login: string };
    return { detail: `Authenticated as ${user.login}`, ok: true };
  } catch (err) {
    return {
      detail: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
      ok: false,
    };
  }
}

// ─── Slack ────────────────────────────────────────────────────────────────────

type SlackConfigRow = NonNullable<Awaited<ReturnType<PrismaClient['slackConfig']['findUnique']>>>;

export type SlackConfigInput = {
  botToken?: string;
  clientId?: string | null;
  clientSecret?: string;
  signingSecret?: string;
};

function slackData(row: SlackConfigRow | null) {
  return {
    botToken: maskedSecret(row?.botTokenLastFour),
    clientId: row?.clientId ?? null,
    clientSecret: maskedSecret(row?.clientSecretLastFour),
    signingSecret: maskedSecret(row?.signingSecretLastFour),
  };
}

export async function getSlackConfig(prisma: PrismaClient) {
  const row = await prisma.slackConfig.findUnique({ where: { id: 'default' } });
  return {
    data: slackData(row),
    sources: {
      botToken: src(!!row?.botTokenCiphertext, 'SLACK_BOT_TOKEN'),
      clientId: src(!!row?.clientId, 'SLACK_CLIENT_ID'),
      clientSecret: src(!!row?.clientSecretCiphertext, 'SLACK_CLIENT_SECRET'),
      signingSecret: src(!!row?.signingSecretCiphertext, 'SLACK_SIGNING_SECRET'),
    },
  };
}

export async function updateSlackConfig(
  prisma: PrismaClient,
  body: SlackConfigInput
): Promise<ConfigUpdateResult> {
  const { botToken, clientId, clientSecret, signingSecret } = body;

  const existing = await prisma.slackConfig.findUnique({ where: { id: 'default' } });

  const data: Record<string, unknown> = {};
  if (clientId !== undefined) {
    data.clientId = clientId;
  }

  sealInto(data, 'botToken', botToken);
  sealInto(data, 'clientSecret', clientSecret);
  sealInto(data, 'signingSecret', signingSecret);

  const row = await prisma.slackConfig.upsert({
    create: { id: 'default', ...data },
    update: data,
    where: { id: 'default' },
  });

  const changedFields = changedKeys([
    ['botToken', botToken],
    ['clientId', clientId],
    ['clientSecret', clientSecret],
    ['signingSecret', signingSecret],
  ]);

  return {
    auditAfterJson: { changedFields, clientId: row.clientId },
    changedFields,
    data: {
      ...slackData(row),
      requiresRestart: !!(clientId !== undefined || clientSecret),
    },
    existed: !!existing,
  };
}

export async function testSlackConnection(): Promise<{ detail: string; ok: boolean }> {
  const { botToken } = await resolveSlackConfig();
  if (!botToken) {
    return { detail: 'No Slack bot token configured.', ok: false };
  }
  try {
    const slack = new WebClient(botToken);
    const res = await slack.auth.test();
    if (!res.ok) {
      return { detail: `Slack API error: ${res.error}`, ok: false };
    }
    return {
      detail: `Authenticated as ${res.user} in workspace ${res.team}`,
      ok: true,
    };
  } catch (err) {
    return {
      detail: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
      ok: false,
    };
  }
}

// ─── Storage ──────────────────────────────────────────────────────────────────

type StorageConfigRow = NonNullable<
  Awaited<ReturnType<PrismaClient['storageConfig']['findUnique']>>
>;

export type StorageConfigInput = {
  awsAccessKeyId?: string | null;
  awsSecretAccessKey?: string;
  backend?: 'inline' | 's3';
  s3Bucket?: string | null;
  s3Endpoint?: string | null;
  s3ForcePathStyle?: boolean;
  s3Prefix?: string | null;
  s3Region?: string | null;
};

function storageData(row: StorageConfigRow | null) {
  return {
    awsAccessKeyId: row?.awsAccessKeyId ?? null,
    awsSecretAccessKey: maskedSecret(row?.awsSecretAccessKeyLastFour),
    backend: row?.backend ?? 'inline',
    s3Bucket: row?.s3Bucket ?? null,
    s3Endpoint: row?.s3Endpoint ?? null,
    s3ForcePathStyle: row?.s3ForcePathStyle ?? false,
    s3Prefix: row?.s3Prefix ?? null,
    s3Region: row?.s3Region ?? null,
  };
}

export async function getStorageConfig(prisma: PrismaClient) {
  const row = await prisma.storageConfig.findUnique({ where: { id: 'default' } });
  return {
    data: storageData(row),
    sources: {
      awsAccessKeyId: src(!!row?.awsAccessKeyId, 'AWS_ACCESS_KEY_ID'),
      awsSecretAccessKey: src(!!row?.awsSecretAccessKeyCiphertext, 'AWS_SECRET_ACCESS_KEY'),
      backend: src(!!row?.backend, 'ARTIFACT_S3_BUCKET'),
      s3Bucket: src(!!row?.s3Bucket, 'ARTIFACT_S3_BUCKET'),
      s3Endpoint: src(!!row?.s3Endpoint, 'ARTIFACT_S3_ENDPOINT'),
      s3ForcePathStyle: src(
        row?.s3ForcePathStyle !== null && row?.s3ForcePathStyle !== undefined,
        'ARTIFACT_S3_FORCE_PATH_STYLE'
      ),
      s3Prefix: src(!!row?.s3Prefix, 'ARTIFACT_S3_PREFIX'),
      s3Region: src(!!row?.s3Region, 'ARTIFACT_S3_REGION'),
    },
  };
}

export async function updateStorageConfig(
  prisma: PrismaClient,
  body: StorageConfigInput
): Promise<ConfigUpdateResult> {
  const {
    backend,
    s3Bucket,
    s3Region,
    s3Endpoint,
    s3Prefix,
    s3ForcePathStyle,
    awsAccessKeyId,
    awsSecretAccessKey,
  } = body;

  const existing = await prisma.storageConfig.findUnique({ where: { id: 'default' } });

  const data: Record<string, unknown> = {};
  if (backend !== undefined) {
    data.backend = backend;
  }
  // Providing s3Bucket without an explicit backend implies S3 mode. This
  // prevents a partial PUT from writing the Prisma default 'inline' to the
  // DB, which would make it impossible to distinguish "admin chose inline"
  // from "admin never set backend" in the resolver.
  else if (s3Bucket !== undefined && s3Bucket !== null) {
    data.backend = 's3';
  }
  if (s3Bucket !== undefined) {
    data.s3Bucket = s3Bucket;
  }
  if (s3Region !== undefined) {
    data.s3Region = s3Region;
  }
  if (s3Endpoint !== undefined) {
    data.s3Endpoint = s3Endpoint;
  }
  if (s3Prefix !== undefined) {
    data.s3Prefix = s3Prefix;
  }
  if (s3ForcePathStyle !== undefined) {
    data.s3ForcePathStyle = s3ForcePathStyle;
  }
  if (awsAccessKeyId !== undefined) {
    data.awsAccessKeyId = awsAccessKeyId;
  }

  sealInto(data, 'awsSecretAccessKey', awsSecretAccessKey);

  const row = await prisma.storageConfig.upsert({
    create: { id: 'default', ...data },
    update: data,
    where: { id: 'default' },
  });

  const changedFields = changedKeys([
    ['backend', backend],
    ['s3Bucket', s3Bucket],
    ['s3Region', s3Region],
    ['s3Endpoint', s3Endpoint],
    ['s3Prefix', s3Prefix],
    ['s3ForcePathStyle', s3ForcePathStyle],
    ['awsAccessKeyId', awsAccessKeyId],
    ['awsSecretAccessKey', awsSecretAccessKey],
  ]);

  return {
    auditAfterJson: {
      awsAccessKeyId: row.awsAccessKeyId,
      backend: row.backend,
      changedFields,
      s3Bucket: row.s3Bucket,
      s3Endpoint: row.s3Endpoint,
      s3ForcePathStyle: row.s3ForcePathStyle,
      s3Prefix: row.s3Prefix,
      s3Region: row.s3Region,
    },
    changedFields,
    data: storageData(row),
    existed: !!existing,
  };
}

export async function testStorageConnection(): Promise<{ detail: string; ok: boolean }> {
  const config = await resolveStorageConfig();
  if (config.backend === 'inline') {
    return {
      detail: 'Inline (Postgres) storage — no external connection needed.',
      ok: true,
    };
  }
  if (!config.s3Bucket) {
    return { detail: 'S3 backend selected but no bucket configured.', ok: false };
  }

  const endpoint = config.s3Endpoint;
  const region = config.s3Region ?? 'us-east-1';
  const url = endpoint
    ? `${endpoint}/${config.s3Bucket}`
    : `https://${config.s3Bucket}.s3.${region}.amazonaws.com/`;

  try {
    // Use GET rather than HEAD — some S3-compatible services (MinIO, R2) return
    // 405 for HEAD on bucket paths, masking real reachability.
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(8_000),
    });
    // 403 / 400 → endpoint reachable, auth error (expected without signed request)
    // 200 / 301 → bucket accessible
    // 404 → endpoint reachable but bucket missing
    if (res.status === 404) {
      return {
        detail: `Endpoint reachable but bucket '${config.s3Bucket}' not found (404).`,
        ok: false,
      };
    }
    return {
      detail: `Endpoint reachable (HTTP ${res.status}). Note: credential verification requires a signed request.`,
      ok: true,
    };
  } catch (err) {
    return {
      detail: `Cannot reach S3 endpoint: ${err instanceof Error ? err.message : String(err)}`,
      ok: false,
    };
  }
}

// ─── Google OAuth ─────────────────────────────────────────────────────────────

type GoogleOAuthConfigRow = NonNullable<
  Awaited<ReturnType<PrismaClient['googleOAuthConfig']['findUnique']>>
>;

export type GoogleOAuthConfigInput = {
  clientId?: string | null;
  clientSecret?: string;
};

function googleOAuthData(row: GoogleOAuthConfigRow | null) {
  return {
    clientId: row?.clientId ?? null,
    clientSecret: maskedSecret(row?.clientSecretLastFour),
  };
}

export async function getGoogleOAuthConfig(prisma: PrismaClient) {
  const row = await prisma.googleOAuthConfig.findUnique({ where: { id: 'default' } });
  return {
    data: googleOAuthData(row),
    sources: {
      clientId: src(!!row?.clientId, 'GOOGLE_CLIENT_ID'),
      clientSecret: src(!!row?.clientSecretCiphertext, 'GOOGLE_CLIENT_SECRET'),
    },
  };
}

export async function updateGoogleOAuthConfig(
  prisma: PrismaClient,
  body: GoogleOAuthConfigInput
): Promise<ConfigUpdateResult> {
  const { clientId, clientSecret } = body;

  const existing = await prisma.googleOAuthConfig.findUnique({ where: { id: 'default' } });

  const data: Record<string, unknown> = {};
  if (clientId !== undefined) {
    data.clientId = clientId;
  }

  sealInto(data, 'clientSecret', clientSecret);

  const row = await prisma.googleOAuthConfig.upsert({
    create: { id: 'default', ...data },
    update: data,
    where: { id: 'default' },
  });

  const changedFields = changedKeys([
    ['clientId', clientId],
    ['clientSecret', clientSecret],
  ]);

  return {
    auditAfterJson: { changedFields, clientId: row.clientId },
    changedFields,
    data: { ...googleOAuthData(row), requiresRestart: true },
    existed: !!existing,
  };
}

// ─── Issue tracker ────────────────────────────────────────────────────────────

type IssueTrackerConfigRow = NonNullable<
  Awaited<ReturnType<PrismaClient['issueTrackerConfig']['findUnique']>>
>;

export type IssueTrackerConfigInput = {
  apiToken?: string;
  baseUrl?: string | null;
  defaultProjectKey?: string | null;
  email?: string | null;
  epicIssueType?: string | null;
  instanceType?: 'cloud' | 'server' | 'datacenter' | null;
  maxRetries?: number | null;
  provider?: 'jira' | 'linear' | 'github' | null;
  storyIssueType?: string | null;
  storyPointsFieldId?: string | null;
  timeoutMs?: number | null;
  webhookSecret?: string | null;
  webhookTriggerStatus?: string | null;
};

function issueTrackerData(row: IssueTrackerConfigRow | null) {
  return {
    apiToken: maskedSecret(row?.apiTokenLastFour),
    baseUrl: row?.baseUrl ?? null,
    defaultProjectKey: row?.defaultProjectKey ?? null,
    email: row?.email ?? null,
    epicIssueType: row?.epicIssueType ?? null,
    instanceType: row?.instanceType ?? null,
    maxRetries: row?.maxRetries ?? null,
    provider: row?.provider ?? null,
    storyIssueType: row?.storyIssueType ?? null,
    storyPointsFieldId: row?.storyPointsFieldId ?? null,
    timeoutMs: row?.timeoutMs ?? null,
    webhookSecret: row?.webhookSecret ?? null,
    webhookTriggerStatus: row?.webhookTriggerStatus ?? null,
  };
}

export async function getIssueTrackerConfig(prisma: PrismaClient) {
  const row = await prisma.issueTrackerConfig.findUnique({ where: { id: 'default' } });
  return {
    data: issueTrackerData(row),
    sources: {
      apiToken: src(!!row?.apiTokenCiphertext, 'TRACKER_API_TOKEN'),
      baseUrl: src(!!row?.baseUrl, 'TRACKER_BASE_URL'),
      email: src(!!row?.email, 'TRACKER_EMAIL'),
      provider: src(!!row?.provider, 'TRACKER_PROVIDER'),
    },
  };
}

export async function updateIssueTrackerConfig(
  prisma: PrismaClient,
  body: IssueTrackerConfigInput
): Promise<ConfigUpdateResult> {
  const {
    apiToken,
    baseUrl,
    defaultProjectKey,
    email,
    epicIssueType,
    instanceType,
    maxRetries,
    provider,
    storyIssueType,
    storyPointsFieldId,
    timeoutMs,
    webhookSecret,
    webhookTriggerStatus,
  } = body;

  const existing = await prisma.issueTrackerConfig.findUnique({ where: { id: 'default' } });

  const data: Record<string, unknown> = {};
  if (provider !== undefined) {
    data.provider = provider;
  }
  if (baseUrl !== undefined) {
    data.baseUrl = baseUrl;
  }
  if (email !== undefined) {
    data.email = email;
  }
  if (instanceType !== undefined) {
    data.instanceType = instanceType;
  }
  if (timeoutMs !== undefined) {
    data.timeoutMs = timeoutMs;
  }
  if (maxRetries !== undefined) {
    data.maxRetries = maxRetries;
  }
  if (storyPointsFieldId !== undefined) {
    data.storyPointsFieldId = storyPointsFieldId;
  }
  if (epicIssueType !== undefined) {
    data.epicIssueType = epicIssueType;
  }
  if (storyIssueType !== undefined) {
    data.storyIssueType = storyIssueType;
  }
  if (defaultProjectKey !== undefined) {
    data.defaultProjectKey = defaultProjectKey;
  }
  if (webhookSecret !== undefined) {
    data.webhookSecret = webhookSecret;
  }
  if (webhookTriggerStatus !== undefined) {
    data.webhookTriggerStatus = webhookTriggerStatus;
  }

  sealInto(data, 'apiToken', apiToken);

  const row = await prisma.issueTrackerConfig.upsert({
    create: { id: 'default', ...data },
    update: data,
    where: { id: 'default' },
  });

  const changedFields = changedKeys([
    ['provider', provider],
    ['baseUrl', baseUrl],
    ['email', email],
    ['apiToken', apiToken],
    ['instanceType', instanceType],
    ['timeoutMs', timeoutMs],
    ['maxRetries', maxRetries],
    ['storyPointsFieldId', storyPointsFieldId],
    ['epicIssueType', epicIssueType],
    ['storyIssueType', storyIssueType],
    ['defaultProjectKey', defaultProjectKey],
    ['webhookSecret', webhookSecret],
    ['webhookTriggerStatus', webhookTriggerStatus],
  ]);

  return {
    auditAfterJson: {
      baseUrl: row.baseUrl,
      changedFields,
      defaultProjectKey: row.defaultProjectKey,
      email: row.email,
      epicIssueType: row.epicIssueType,
      instanceType: row.instanceType,
      provider: row.provider,
      storyIssueType: row.storyIssueType,
      webhookTriggerStatus: row.webhookTriggerStatus,
    },
    changedFields,
    data: issueTrackerData(row),
    existed: !!existing,
  };
}

/// Live connection test: fetches a caller-supplied ticket ID through the
/// configured connector and reports its title/status (or the failure).
export async function testIssueTrackerConnection(
  ticketId: string
): Promise<{ detail: string; ok: boolean }> {
  const config = await resolveIssueTrackerConfig();
  if (!config.provider) {
    return { detail: 'No tracker provider configured.', ok: false };
  }
  // Imported lazily so unit tests can mock the connector module.
  const { fetchTicket } = await import('./issueTrackerClient.js');
  const warnings: string[] = [];
  const ticket = await fetchTicket(config, ticketId, {
    log: { warn: (_obj, msg) => warnings.push(msg ?? 'unknown failure') },
  });
  if (!ticket) {
    return {
      detail: `Could not fetch ${ticketId} via ${config.provider}: ${warnings.at(-1) ?? 'fetch failed'}`,
      ok: false,
    };
  }
  return {
    detail: `Fetched "${ticket.title}" (status: ${ticket.status}) from ${config.provider}.`,
    ok: true,
  };
}

// ─── Knowledge base ────────────────────────────────────────────────────────────

type KnowledgeBaseConfigRow = NonNullable<
  Awaited<ReturnType<PrismaClient['knowledgeBaseConfig']['findUnique']>>
>;

export type KnowledgeBaseConfigInput = {
  apiToken?: string;
  baseUrl?: string | null;
  email?: string | null;
  enabled?: boolean;
  maxPages?: number | null;
  provider?: 'confluence' | 'notion' | null;
  spaces?: string[];
};

function knowledgeBaseData(row: KnowledgeBaseConfigRow | null) {
  return {
    apiToken: maskedSecret(row?.apiTokenLastFour),
    baseUrl: row?.baseUrl ?? null,
    email: row?.email ?? null,
    enabled: row?.enabled ?? false,
    maxPages: row?.maxPages ?? null,
    provider: row?.provider ?? null,
    spaces: row?.spaces ?? [],
  };
}

export async function getKnowledgeBaseConfig(prisma: PrismaClient) {
  const row = await prisma.knowledgeBaseConfig.findUnique({ where: { id: 'default' } });
  return {
    data: knowledgeBaseData(row),
    sources: {
      apiToken: src(!!row?.apiTokenCiphertext, 'KB_API_TOKEN'),
      baseUrl: src(!!row?.baseUrl, 'KB_BASE_URL'),
      email: src(!!row?.email, 'KB_EMAIL'),
      provider: src(!!row?.provider, 'KB_PROVIDER'),
      spaces: src(!!row?.spaces?.length, 'KB_SPACES'),
    },
  };
}

export async function updateKnowledgeBaseConfig(
  prisma: PrismaClient,
  body: KnowledgeBaseConfigInput
): Promise<ConfigUpdateResult> {
  const { apiToken, baseUrl, email, enabled, maxPages, provider, spaces } = body;

  const existing = await prisma.knowledgeBaseConfig.findUnique({ where: { id: 'default' } });

  const data: Record<string, unknown> = {};
  if (provider !== undefined) {
    data.provider = provider;
  }
  if (enabled !== undefined) {
    data.enabled = enabled;
  }
  if (baseUrl !== undefined) {
    data.baseUrl = baseUrl;
  }
  if (email !== undefined) {
    data.email = email;
  }
  if (spaces !== undefined) {
    data.spaces = spaces;
  }
  if (maxPages !== undefined) {
    data.maxPages = maxPages;
  }

  sealInto(data, 'apiToken', apiToken);

  const row = await prisma.knowledgeBaseConfig.upsert({
    create: { id: 'default', ...data },
    update: data,
    where: { id: 'default' },
  });

  const changedFields = changedKeys([
    ['provider', provider],
    ['enabled', enabled],
    ['baseUrl', baseUrl],
    ['email', email],
    ['spaces', spaces],
    ['maxPages', maxPages],
    ['apiToken', apiToken],
  ]);

  return {
    auditAfterJson: {
      baseUrl: row.baseUrl,
      changedFields,
      email: row.email,
      enabled: row.enabled,
      maxPages: row.maxPages,
      provider: row.provider,
      spaces: row.spaces,
    },
    changedFields,
    data: knowledgeBaseData(row),
    existed: !!existing,
  };
}

export async function testKnowledgeBaseConnection(): Promise<{ detail: string; ok: boolean }> {
  const config = await resolveKnowledgeBaseConfig();
  if (!config.provider || !config.enabled) {
    return { detail: 'Knowledge base provider not configured or disabled.', ok: false };
  }
  if (!config.baseUrl || !config.apiToken) {
    return {
      detail: `Knowledge base (${config.provider}) missing baseUrl or apiToken.`,
      ok: false,
    };
  }
  // For Confluence: do a lightweight CQL search to validate credentials.
  if (config.provider === 'confluence') {
    try {
      const base = config.baseUrl.replace(/\/$/, '');
      const credentials = Buffer.from(`${config.email ?? ''}:${config.apiToken}`).toString(
        'base64'
      );
      const res = await fetch(`${base}/wiki/rest/api/content/search?cql=type%3Dpage&limit=1`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${credentials}`,
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        return {
          detail: `Confluence API returned ${res.status}: ${res.statusText}`,
          ok: false,
        };
      }
      return { detail: 'Confluence connection successful.', ok: true };
    } catch (err) {
      return {
        detail: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
        ok: false,
      };
    }
  }
  return { detail: `Provider ${config.provider} connected (no test implemented).`, ok: true };
}

// ─── Consolidation schedule ───────────────────────────────────────────────────

export type ConsolidationConfigInput = {
  cronExpression?: string;
  enabled?: boolean;
  minClusterSize?: number;
  similarityThreshold?: number;
};

/// Writes the consolidation fields onto the WorkflowDefaults singleton.
export async function updateConsolidationConfig(
  prisma: PrismaClient,
  body: ConsolidationConfigInput
): Promise<void> {
  const { enabled, cronExpression, minClusterSize, similarityThreshold } = body;

  const data: Record<string, unknown> = {};
  if (enabled !== undefined) {
    data.consolidationEnabled = enabled;
  }
  if (cronExpression !== undefined) {
    data.consolidationCron = cronExpression;
  }
  if (minClusterSize !== undefined) {
    data.consolidationMinClusterSize = minClusterSize;
  }
  if (similarityThreshold !== undefined) {
    data.consolidationSimilarityThreshold = similarityThreshold;
  }

  await prisma.workflowDefaults.upsert({
    create: { id: 'default', ...data },
    update: data,
    where: { id: 'default' },
  });
}

// ─── Audit log + decrypt check ────────────────────────────────────────────────

/// Returns recent config audit entries with actor emails resolved in one
/// batch query.
export async function listConfigAuditEntries(prisma: PrismaClient, take: number) {
  const entries = await prisma.configAuditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take,
  });

  // Resolve actor emails in one batch query
  const actorIds = [...new Set(entries.map((e) => e.actorId).filter(Boolean))] as string[];
  const actors =
    actorIds.length > 0
      ? await prisma.user.findMany({
          select: { email: true, id: true },
          where: { id: { in: actorIds } },
        })
      : [];
  const actorMap = new Map(actors.map((a) => [a.id, a.email]));

  return entries.map((e) => ({
    ...e,
    actorEmail: e.actorId ? (actorMap.get(e.actorId) ?? null) : null,
    createdAt: e.createdAt.toISOString(),
  }));
}

// ─── Jira field detection ─────────────────────────────────────────────────────

/// Calls Jira GET /rest/api/3/field and returns all custom fields plus a best-guess
/// for the Story Points field ID (e.g. `story_points` or a custom field named like it).
export async function detectJiraFields(): Promise<{
  storyPointsFieldId: string | null;
  fields: { id: string; name: string }[];
}> {
  const config = await resolveIssueTrackerConfig();
  if (config.provider !== 'jira' || !config.baseUrl || !config.apiToken) {
    throw new Error('Jira is not configured');
  }
  const url = `${config.baseUrl.replace(/\/$/, '')}/rest/api/3/field`;
  const authHeader = Buffer.from(`${config.email ?? ''}:${config.apiToken}`).toString('base64');
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${authHeader}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Jira field list failed: ${res.status}`);
  }
  const allFields = (await res.json()) as { id: string; name: string }[];
  const spField = allFields.find(
    (f) => f.name.toLowerCase().includes('story point') || f.id === 'story_points'
  );
  return {
    fields: allFields.map((f) => ({ id: f.id, name: f.name })),
    storyPointsFieldId: spField?.id ?? null,
  };
}

/// Checks that decryption works for stored secrets (currently the GitHub
/// token) without returning any plaintext.
export async function testDecryptSecrets(prisma: PrismaClient): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  try {
    const gh = await prisma.gitHubConfig.findUnique({ where: { id: 'default' } });
    if (gh?.tokenCiphertext && gh.tokenNonce && gh.tokenAuthTag && gh.tokenKeyVersion !== null) {
      decryptSecret({
        authTag: gh.tokenAuthTag,
        ciphertext: gh.tokenCiphertext,
        keyVersion: gh.tokenKeyVersion,
        nonce: gh.tokenNonce,
      });
      results.githubToken = 'ok';
    } else {
      results.githubToken = 'not configured';
    }
  } catch (e) {
    results.githubToken = `error: ${e instanceof Error ? e.message : e}`;
  }
  return results;
}
