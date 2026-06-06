import { prisma } from '@auto-swe/shared/db';
import { decryptSecret, encryptSecret } from '@auto-swe/shared/lib/crypto';
import {
  resolveConsolidationConfig,
  resolveGitHubConfig,
  resolveSlackConfig,
  resolveStorageConfig,
  resolveWorkflowDefaults,
} from '@auto-swe/shared/lib/systemConfig';
import { WebClient } from '@slack/web-api';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireUser } from '../plugins/auth.js';

/// Admin CRUD routes for the five singleton system-config tables:
///   GET/PUT /api/v1/admin/config/github
///   GET/PUT /api/v1/admin/config/slack
///   GET/PUT /api/v1/admin/config/storage
///   GET/PUT /api/v1/admin/config/workflow-defaults
///   GET/PUT /api/v1/admin/config/oauth/google
///
/// Also:
///   POST /api/v1/admin/config/github/test   — live connection test
///   POST /api/v1/admin/config/slack/test    — live connection test
///   POST /api/v1/admin/config/storage/test  — connectivity test
///   GET  /api/v1/admin/config/audit-log     — config change history
///
/// All routes require platform ADMIN role.
/// Secret fields are write-only from the API: reads return `lastFour` only,
/// never the plaintext (same convention as /admin/config/credentials).

// ─── constants ────────────────────────────────────────────────────────────────

// Fixed UUIDs for the five singleton system-config entities.
// Used as entityId in ConfigAuditLog (which requires a UUID PK) since the
// config tables use the string 'default' as their PK.
const SYSTEM_CONFIG_IDS = {
  github: '00000000-0000-0000-0001-000000000001',
  googleOAuth: '00000000-0000-0000-0001-000000000005',
  slack: '00000000-0000-0000-0001-000000000002',
  storage: '00000000-0000-0000-0001-000000000003',
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

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const GitHubPutBody = z.object({
  apiUrl: z.string().url().max(500).nullable().optional(),
  appClientId: z.string().max(200).nullable().optional(),
  appClientSecret: z.string().min(1).max(500).optional(),
  appId: z.string().max(100).nullable().optional(),
  appInstallationId: z.string().max(100).nullable().optional(),
  appPrivateKey: z.string().min(1).max(10_000).optional(),
  authMode: z.enum(['auto', 'pat', 'app']).nullable().optional(),
  baseUrl: z.string().url().max(500).nullable().optional(),
  oauthClientId: z.string().max(200).nullable().optional(),
  oauthClientSecret: z.string().min(1).max(500).optional(),
  token: z.string().min(1).max(500).optional(),
  webhookSecret: z.string().min(1).max(500).optional(),
});

const SlackPutBody = z.object({
  botToken: z.string().min(1).max(500).optional(),
  clientId: z.string().max(200).nullable().optional(),
  clientSecret: z.string().min(1).max(500).optional(),
  signingSecret: z.string().min(1).max(500).optional(),
});

const StoragePutBody = z
  .object({
    awsAccessKeyId: z.string().max(200).nullable().optional(),
    awsSecretAccessKey: z.string().min(1).max(500).optional(),
    backend: z.enum(['inline', 's3']).optional(),
    s3Bucket: z.string().min(1).max(200).nullable().optional(),
    s3Endpoint: z.string().url().max(500).nullable().optional(),
    s3ForcePathStyle: z.boolean().optional(),
    s3Prefix: z.string().max(200).nullable().optional(),
    s3Region: z.string().max(50).nullable().optional(),
  })
  .refine((v) => v.backend !== 's3' || (v.s3Bucket !== undefined && v.s3Bucket !== null), {
    message: 'backend=s3 requires s3Bucket',
  });

const WorkflowDefaultsPutBody = z.object({
  branchPrefix: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9/-]*$/, 'must be lowercase alphanumeric with - or /')
    .optional(),
  defaultTeamSlug: z.string().min(1).max(100).optional(),
  prBodyTemplate: z.string().max(10_000).optional(),
  prTitleTemplate: z.string().min(1).max(500).optional(),
});

const ConsolidationPutBody = z.object({
  cronExpression: z
    .string()
    .min(1)
    .max(100)
    .regex(/^(\S+\s+){4}\S+$/, 'must be a valid 5-field cron expression (e.g. "0 3 * * 0")')
    .optional(),
  enabled: z.boolean().optional(),
  minClusterSize: z.number().int().min(2).max(20).optional(),
  similarityThreshold: z.number().min(0.5).max(1).optional(),
});

const GoogleOAuthPutBody = z.object({
  clientId: z.string().max(200).nullable().optional(),
  clientSecret: z.string().min(1).max(500).optional(),
});

// ─── route plugin ─────────────────────────────────────────────────────────────

export const systemConfigRoutes: FastifyPluginAsync = async (
  fastify: FastifyInstance
): Promise<void> => {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes below require ADMIN
  f.addHook('onRequest', requireAuth({ requiredRole: 'ADMIN' }));

  // ── GitHub ──────────────────────────────────────────────────────────────────

  f.get('/config/github', { schema: { response: { 200: z.any() } } }, async (_req, reply) => {
    const row = await prisma.gitHubConfig.findUnique({ where: { id: 'default' } });
    return reply.send({
      data: {
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
      },
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
    });
  });

  f.put(
    '/config/github',
    { schema: { body: GitHubPutBody, response: { 200: z.any() } } },
    async (req, reply) => {
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
      } = req.body;

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
      if (changedFields.length > 0) {
        const actor = requireUser(req);
        try {
          await prisma.configAuditLog.create({
            data: {
              action: existing ? 'UPDATE' : 'CREATE',
              actorId: actor.sub,
              afterJson: {
                apiUrl: row.apiUrl,
                appClientId: row.appClientId,
                appId: row.appId,
                appInstallationId: row.appInstallationId,
                authMode: row.authMode,
                baseUrl: row.baseUrl,
                changedFields,
                oauthClientId: row.oauthClientId,
              } as never,
              entityId: SYSTEM_CONFIG_IDS.github,
              entityType: 'GitHubConfig',
            },
          });
        } catch (auditErr) {
          fastify.log.warn({ err: auditErr }, 'Failed to write GitHubConfig audit log');
        }
      }

      return reply.send({
        data: {
          apiUrl: row.apiUrl,
          appClientId: row.appClientId,
          appClientSecret: maskedSecret(row.appClientSecretLastFour),
          appId: row.appId,
          appInstallationId: row.appInstallationId,
          appPrivateKey: maskedSecret(row.appPrivateKeyLastFour),
          authMode: row.authMode,
          baseUrl: row.baseUrl,
          oauthClientId: row.oauthClientId,
          oauthClientSecret: maskedSecret(row.oauthClientSecretLastFour),
          requiresRestart: !!(oauthClientId !== undefined || oauthClientSecret),
          token: maskedSecret(row.tokenLastFour),
          webhookSecret: maskedSecret(row.webhookSecretLastFour),
        },
      });
    }
  );

  // ── GitHub: connection test ──────────────────────────────────────────────────

  f.post('/config/github/test', { schema: { response: { 200: z.any() } } }, async (_req, reply) => {
    const config = await resolveGitHubConfig();

    const appConfigured = config.appId && config.appPrivateKey && config.appInstallationId;
    const mode = config.authMode ?? 'auto';
    const useApp = mode === 'app' || (mode === 'auto' && appConfigured);

    if (useApp) {
      return reply.send({
        detail: `GitHub App configured (id: ${config.appId}, installation: ${config.appInstallationId}). Start the worker to validate token generation.`,
        ok: true,
      });
    }

    if (!config.token) {
      return reply.send({ detail: 'No GitHub token configured.', ok: false });
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
        return reply.send({
          detail: `GitHub API returned ${res.status}: ${body.message ?? res.statusText}`,
          ok: false,
        });
      }
      const user = (await res.json()) as { login: string };
      return reply.send({ detail: `Authenticated as ${user.login}`, ok: true });
    } catch (err) {
      return reply.send({
        detail: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
        ok: false,
      });
    }
  });

  // ── Slack ───────────────────────────────────────────────────────────────────

  f.get('/config/slack', { schema: { response: { 200: z.any() } } }, async (_req, reply) => {
    const row = await prisma.slackConfig.findUnique({ where: { id: 'default' } });
    return reply.send({
      data: {
        botToken: maskedSecret(row?.botTokenLastFour),
        clientId: row?.clientId ?? null,
        clientSecret: maskedSecret(row?.clientSecretLastFour),
        signingSecret: maskedSecret(row?.signingSecretLastFour),
      },
      sources: {
        botToken: src(!!row?.botTokenCiphertext, 'SLACK_BOT_TOKEN'),
        clientId: src(!!row?.clientId, 'SLACK_CLIENT_ID'),
        clientSecret: src(!!row?.clientSecretCiphertext, 'SLACK_CLIENT_SECRET'),
        signingSecret: src(!!row?.signingSecretCiphertext, 'SLACK_SIGNING_SECRET'),
      },
    });
  });

  f.put(
    '/config/slack',
    { schema: { body: SlackPutBody, response: { 200: z.any() } } },
    async (req, reply) => {
      const { botToken, clientId, clientSecret, signingSecret } = req.body;

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
      if (changedFields.length > 0) {
        const actor = requireUser(req);
        try {
          await prisma.configAuditLog.create({
            data: {
              action: existing ? 'UPDATE' : 'CREATE',
              actorId: actor.sub,
              afterJson: { changedFields, clientId: row.clientId } as never,
              entityId: SYSTEM_CONFIG_IDS.slack,
              entityType: 'SlackConfig',
            },
          });
        } catch (auditErr) {
          fastify.log.warn({ err: auditErr }, 'Failed to write SlackConfig audit log');
        }
      }

      return reply.send({
        data: {
          botToken: maskedSecret(row.botTokenLastFour),
          clientId: row.clientId,
          clientSecret: maskedSecret(row.clientSecretLastFour),
          requiresRestart: !!(clientId !== undefined || clientSecret),
          signingSecret: maskedSecret(row.signingSecretLastFour),
        },
      });
    }
  );

  // ── Slack: connection test ───────────────────────────────────────────────────

  f.post('/config/slack/test', { schema: { response: { 200: z.any() } } }, async (_req, reply) => {
    const { botToken } = await resolveSlackConfig();
    if (!botToken) {
      return reply.send({ detail: 'No Slack bot token configured.', ok: false });
    }
    try {
      const slack = new WebClient(botToken);
      const res = await slack.auth.test();
      if (!res.ok) {
        return reply.send({ detail: `Slack API error: ${res.error}`, ok: false });
      }
      return reply.send({
        detail: `Authenticated as ${res.user} in workspace ${res.team}`,
        ok: true,
      });
    } catch (err) {
      return reply.send({
        detail: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
        ok: false,
      });
    }
  });

  // ── Storage ─────────────────────────────────────────────────────────────────

  f.get('/config/storage', { schema: { response: { 200: z.any() } } }, async (_req, reply) => {
    const row = await prisma.storageConfig.findUnique({ where: { id: 'default' } });
    return reply.send({
      data: {
        awsAccessKeyId: row?.awsAccessKeyId ?? null,
        awsSecretAccessKey: maskedSecret(row?.awsSecretAccessKeyLastFour),
        backend: row?.backend ?? 'inline',
        s3Bucket: row?.s3Bucket ?? null,
        s3Endpoint: row?.s3Endpoint ?? null,
        s3ForcePathStyle: row?.s3ForcePathStyle ?? false,
        s3Prefix: row?.s3Prefix ?? null,
        s3Region: row?.s3Region ?? null,
      },
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
    });
  });

  f.put(
    '/config/storage',
    { schema: { body: StoragePutBody, response: { 200: z.any() } } },
    async (req, reply) => {
      const {
        backend,
        s3Bucket,
        s3Region,
        s3Endpoint,
        s3Prefix,
        s3ForcePathStyle,
        awsAccessKeyId,
        awsSecretAccessKey,
      } = req.body;

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
      if (changedFields.length > 0) {
        const actor = requireUser(req);
        try {
          await prisma.configAuditLog.create({
            data: {
              action: existing ? 'UPDATE' : 'CREATE',
              actorId: actor.sub,
              afterJson: {
                awsAccessKeyId: row.awsAccessKeyId,
                backend: row.backend,
                changedFields,
                s3Bucket: row.s3Bucket,
                s3Endpoint: row.s3Endpoint,
                s3ForcePathStyle: row.s3ForcePathStyle,
                s3Prefix: row.s3Prefix,
                s3Region: row.s3Region,
              } as never,
              entityId: SYSTEM_CONFIG_IDS.storage,
              entityType: 'StorageConfig',
            },
          });
        } catch (auditErr) {
          fastify.log.warn({ err: auditErr }, 'Failed to write StorageConfig audit log');
        }
      }

      return reply.send({
        data: {
          awsAccessKeyId: row.awsAccessKeyId,
          awsSecretAccessKey: maskedSecret(row.awsSecretAccessKeyLastFour),
          backend: row.backend,
          s3Bucket: row.s3Bucket,
          s3Endpoint: row.s3Endpoint,
          s3ForcePathStyle: row.s3ForcePathStyle,
          s3Prefix: row.s3Prefix,
          s3Region: row.s3Region,
        },
      });
    }
  );

  // ── Storage: connection test ─────────────────────────────────────────────────

  f.post(
    '/config/storage/test',
    { schema: { response: { 200: z.any() } } },
    async (_req, reply) => {
      const config = await resolveStorageConfig();
      if (config.backend === 'inline') {
        return reply.send({
          detail: 'Inline (Postgres) storage — no external connection needed.',
          ok: true,
        });
      }
      if (!config.s3Bucket) {
        return reply.send({ detail: 'S3 backend selected but no bucket configured.', ok: false });
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
          return reply.send({
            detail: `Endpoint reachable but bucket '${config.s3Bucket}' not found (404).`,
            ok: false,
          });
        }
        return reply.send({
          detail: `Endpoint reachable (HTTP ${res.status}). Note: credential verification requires a signed request.`,
          ok: true,
        });
      } catch (err) {
        return reply.send({
          detail: `Cannot reach S3 endpoint: ${err instanceof Error ? err.message : String(err)}`,
          ok: false,
        });
      }
    }
  );

  // ── Workflow defaults ────────────────────────────────────────────────────────

  f.get(
    '/config/workflow-defaults',
    { schema: { response: { 200: z.any() } } },
    async (_req, reply) => reply.send({ data: await resolveWorkflowDefaults() })
  );

  f.put(
    '/config/workflow-defaults',
    { schema: { body: WorkflowDefaultsPutBody, response: { 200: z.any() } } },
    async (req, reply) => {
      await prisma.workflowDefaults.upsert({
        create: { id: 'default', ...req.body },
        update: req.body,
        where: { id: 'default' },
      });
      // Return through the shared resolver so GET and PUT always produce the
      // same shape, including env-var fallbacks for fields not yet set in DB.
      return reply.send({ data: await resolveWorkflowDefaults() });
    }
  );

  // ── Google OAuth ─────────────────────────────────────────────────────────────

  f.get('/config/oauth/google', { schema: { response: { 200: z.any() } } }, async (_req, reply) => {
    const row = await prisma.googleOAuthConfig.findUnique({ where: { id: 'default' } });
    return reply.send({
      data: {
        clientId: row?.clientId ?? null,
        clientSecret: maskedSecret(row?.clientSecretLastFour),
      },
      sources: {
        clientId: src(!!row?.clientId, 'GOOGLE_CLIENT_ID'),
        clientSecret: src(!!row?.clientSecretCiphertext, 'GOOGLE_CLIENT_SECRET'),
      },
    });
  });

  f.put(
    '/config/oauth/google',
    { schema: { body: GoogleOAuthPutBody, response: { 200: z.any() } } },
    async (req, reply) => {
      const { clientId, clientSecret } = req.body;

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
      if (changedFields.length > 0) {
        const actor = requireUser(req);
        try {
          await prisma.configAuditLog.create({
            data: {
              action: existing ? 'UPDATE' : 'CREATE',
              actorId: actor.sub,
              afterJson: { changedFields, clientId: row.clientId } as never,
              entityId: SYSTEM_CONFIG_IDS.googleOAuth,
              entityType: 'GoogleOAuthConfig',
            },
          });
        } catch (auditErr) {
          fastify.log.warn({ err: auditErr }, 'Failed to write GoogleOAuthConfig audit log');
        }
      }

      return reply.send({
        data: {
          clientId: row.clientId,
          clientSecret: maskedSecret(row.clientSecretLastFour),
          requiresRestart: true,
        },
      });
    }
  );

  // ── Config audit log ─────────────────────────────────────────────────────────

  f.get('/config/audit-log', { schema: { response: { 200: z.any() } } }, async (req, reply) => {
    const limitParam = (req.query as { limit?: string }).limit;
    const take = Math.min(Number(limitParam ?? 100), 500);

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

    return reply.send({
      data: entries.map((e) => ({
        ...e,
        actorEmail: e.actorId ? (actorMap.get(e.actorId) ?? null) : null,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  });

  // ── Consolidation schedule ───────────────────────────────────────────────────

  f.get(
    '/config/consolidation',
    { schema: { response: { 200: z.any() } } },
    async (_req, reply) => {
      const config = await resolveConsolidationConfig();
      const status = await fastify.temporal.getConsolidationScheduleStatus();
      return reply.send({ data: { ...config, schedule: status } });
    }
  );

  f.put(
    '/config/consolidation',
    { schema: { body: ConsolidationPutBody, response: { 200: z.any() } } },
    async (req, reply) => {
      const { enabled, cronExpression, minClusterSize, similarityThreshold } = req.body;

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

      const config = await resolveConsolidationConfig();
      await fastify.temporal.syncConsolidationSchedule(config);
      const status = await fastify.temporal.getConsolidationScheduleStatus();
      return reply.send({ data: { ...config, schedule: status } });
    }
  );

  f.post(
    '/config/consolidation/trigger',
    { schema: { response: { 200: z.any() } } },
    async (_req, reply) => {
      await fastify.temporal.triggerConsolidationNow();
      return reply.send({ data: { triggered: true } });
    }
  );

  // ── Test endpoint (checks decryption works for all secrets) ──────────────────

  f.get('/config/test-decrypt', { schema: { response: { 200: z.any() } } }, async (_req, reply) => {
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
    return reply.send({ data: results });
  });
};
