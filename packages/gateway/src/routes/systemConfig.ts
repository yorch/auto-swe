import { prisma } from '@auto-swe/shared/db';
import { decryptSecret, encryptSecret } from '@auto-swe/shared/lib/crypto';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';

/// Admin CRUD routes for the five singleton system-config tables:
///   GET/PUT /api/v1/admin/config/github
///   GET/PUT /api/v1/admin/config/slack
///   GET/PUT /api/v1/admin/config/storage
///   GET/PUT /api/v1/admin/config/workflow-defaults
///   GET/PUT /api/v1/admin/config/oauth/google
///
/// All routes require platform ADMIN role.
/// Secret fields are write-only from the API: reads return `lastFour` only,
/// never the plaintext (same convention as /admin/config/credentials).

// ─── helpers ──────────────────────────────────────────────────────────────────

/// Encrypts `plaintext` and writes the five AES-GCM envelope columns into
/// `data` using `prefix` as the field-name prefix (e.g. prefix='token' →
/// data.tokenCiphertext, data.tokenNonce, …).  No-ops when plaintext is falsy.
function sealInto(
  data: Record<string, unknown>,
  prefix: string,
  plaintext: string | undefined
): void {
  if (!plaintext) return;
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

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const GitHubPutBody = z.object({
  apiUrl: z.string().url().max(500).nullable().optional(),
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
    s3Bucket: z.string().max(200).nullable().optional(),
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
      apiUrl: row?.apiUrl ?? null,
      baseUrl: row?.baseUrl ?? null,
      oauthClientId: row?.oauthClientId ?? null,
      oauthClientSecret: maskedSecret(row?.oauthClientSecretLastFour),
      token: maskedSecret(row?.tokenLastFour),
      webhookSecret: maskedSecret(row?.webhookSecretLastFour),
    });
  });

  f.put(
    '/config/github',
    { schema: { body: GitHubPutBody, response: { 200: z.any() } } },
    async (req, reply) => {
      const { token, webhookSecret, oauthClientSecret, oauthClientId, apiUrl, baseUrl } = req.body;

      const data: Record<string, unknown> = {};
      if (apiUrl !== undefined) data.apiUrl = apiUrl;
      if (baseUrl !== undefined) data.baseUrl = baseUrl;
      if (oauthClientId !== undefined) data.oauthClientId = oauthClientId;

      sealInto(data, 'token', token);
      sealInto(data, 'webhookSecret', webhookSecret);
      sealInto(data, 'oauthClientSecret', oauthClientSecret);

      const row = await prisma.gitHubConfig.upsert({
        create: { id: 'default', ...data },
        update: data,
        where: { id: 'default' },
      });

      return reply.send({
        apiUrl: row.apiUrl,
        baseUrl: row.baseUrl,
        oauthClientId: row.oauthClientId,
        oauthClientSecret: maskedSecret(row.oauthClientSecretLastFour),
        requiresRestart: !!(oauthClientId !== undefined || oauthClientSecret),
        token: maskedSecret(row.tokenLastFour),
        webhookSecret: maskedSecret(row.webhookSecretLastFour),
      });
    }
  );

  // ── Slack ───────────────────────────────────────────────────────────────────

  f.get('/config/slack', { schema: { response: { 200: z.any() } } }, async (_req, reply) => {
    const row = await prisma.slackConfig.findUnique({ where: { id: 'default' } });
    return reply.send({
      botToken: maskedSecret(row?.botTokenLastFour),
      clientId: row?.clientId ?? null,
      clientSecret: maskedSecret(row?.clientSecretLastFour),
      signingSecret: maskedSecret(row?.signingSecretLastFour),
    });
  });

  f.put(
    '/config/slack',
    { schema: { body: SlackPutBody, response: { 200: z.any() } } },
    async (req, reply) => {
      const { botToken, clientId, clientSecret, signingSecret } = req.body;

      const data: Record<string, unknown> = {};
      if (clientId !== undefined) data.clientId = clientId;

      sealInto(data, 'botToken', botToken);
      sealInto(data, 'clientSecret', clientSecret);
      sealInto(data, 'signingSecret', signingSecret);

      const row = await prisma.slackConfig.upsert({
        create: { id: 'default', ...data },
        update: data,
        where: { id: 'default' },
      });

      return reply.send({
        botToken: maskedSecret(row.botTokenLastFour),
        clientId: row.clientId,
        clientSecret: maskedSecret(row.clientSecretLastFour),
        requiresRestart: !!(clientId !== undefined || clientSecret),
        signingSecret: maskedSecret(row.signingSecretLastFour),
      });
    }
  );

  // ── Storage ─────────────────────────────────────────────────────────────────

  f.get('/config/storage', { schema: { response: { 200: z.any() } } }, async (_req, reply) => {
    const row = await prisma.storageConfig.findUnique({ where: { id: 'default' } });
    return reply.send({
      awsAccessKeyId: row?.awsAccessKeyId ?? null,
      awsSecretAccessKey: maskedSecret(row?.awsSecretAccessKeyLastFour),
      backend: row?.backend ?? 'inline',
      s3Bucket: row?.s3Bucket ?? null,
      s3Endpoint: row?.s3Endpoint ?? null,
      s3ForcePathStyle: row?.s3ForcePathStyle ?? false,
      s3Prefix: row?.s3Prefix ?? null,
      s3Region: row?.s3Region ?? null,
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

      const data: Record<string, unknown> = {};
      if (backend !== undefined) data.backend = backend;
      if (s3Bucket !== undefined) data.s3Bucket = s3Bucket;
      if (s3Region !== undefined) data.s3Region = s3Region;
      if (s3Endpoint !== undefined) data.s3Endpoint = s3Endpoint;
      if (s3Prefix !== undefined) data.s3Prefix = s3Prefix;
      if (s3ForcePathStyle !== undefined) data.s3ForcePathStyle = s3ForcePathStyle;
      if (awsAccessKeyId !== undefined) data.awsAccessKeyId = awsAccessKeyId;

      sealInto(data, 'awsSecretAccessKey', awsSecretAccessKey);

      const row = await prisma.storageConfig.upsert({
        create: { id: 'default', ...data },
        update: data,
        where: { id: 'default' },
      });

      return reply.send({
        awsAccessKeyId: row.awsAccessKeyId,
        awsSecretAccessKey: maskedSecret(row.awsSecretAccessKeyLastFour),
        backend: row.backend,
        s3Bucket: row.s3Bucket,
        s3Endpoint: row.s3Endpoint,
        s3ForcePathStyle: row.s3ForcePathStyle,
        s3Prefix: row.s3Prefix,
        s3Region: row.s3Region,
      });
    }
  );

  // ── Workflow defaults ────────────────────────────────────────────────────────

  f.get(
    '/config/workflow-defaults',
    { schema: { response: { 200: z.any() } } },
    async (_req, reply) => {
      return reply.send(await resolveWorkflowDefaults());
    }
  );

  f.put(
    '/config/workflow-defaults',
    { schema: { body: WorkflowDefaultsPutBody, response: { 200: z.any() } } },
    async (req, reply) => {
      const row = await prisma.workflowDefaults.upsert({
        create: { id: 'default', ...req.body },
        update: req.body,
        where: { id: 'default' },
      });
      return reply.send({
        branchPrefix: row.branchPrefix,
        defaultTeamSlug: row.defaultTeamSlug,
        prBodyTemplate: row.prBodyTemplate,
        prTitleTemplate: row.prTitleTemplate,
      });
    }
  );

  // ── Google OAuth ─────────────────────────────────────────────────────────────

  f.get('/config/oauth/google', { schema: { response: { 200: z.any() } } }, async (_req, reply) => {
    const row = await prisma.googleOAuthConfig.findUnique({ where: { id: 'default' } });
    return reply.send({
      clientId: row?.clientId ?? null,
      clientSecret: maskedSecret(row?.clientSecretLastFour),
    });
  });

  f.put(
    '/config/oauth/google',
    { schema: { body: GoogleOAuthPutBody, response: { 200: z.any() } } },
    async (req, reply) => {
      const { clientId, clientSecret } = req.body;

      const data: Record<string, unknown> = {};
      if (clientId !== undefined) data.clientId = clientId;

      sealInto(data, 'clientSecret', clientSecret);

      const row = await prisma.googleOAuthConfig.upsert({
        create: { id: 'default', ...data },
        update: data,
        where: { id: 'default' },
      });

      return reply.send({
        clientId: row.clientId,
        clientSecret: maskedSecret(row.clientSecretLastFour),
        requiresRestart: true,
      });
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
    return reply.send(results);
  });
};
