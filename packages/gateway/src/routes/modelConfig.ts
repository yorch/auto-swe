import { isSafeProbeUrl } from '@auto-swe/shared/lib/ssrfGuard';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import {
  createCredential,
  redactCredential,
  testStoredCredential,
  updateCredential,
} from '../lib/credentialService.js';
import { upsertEmbeddingConfig } from '../lib/modelConfigService.js';
import { type JwtPayload, requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Admin routes for provider credentials + the embedding-model singleton, plus
 * the config audit-log read. Per-role model/prompt config moved to the Agent
 * library (`/api/v1/admin/agent-library`) in P1.5 — see `agentLibrary.ts`.
 *
 * Team-scoped credential variants live in `teamScopedConfigRoutes` (mounted by
 * `teams.ts`). Business logic lives in `lib/credentialService.ts` +
 * `lib/modelConfigService.ts`.
 */

// ── Validation schemas ──

const ModelSpecSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[^/\s]+\/.+$/, 'must be <provider>/<model-id>');

const ProviderSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'provider must be lowercase-kebab-case');

const CredentialCreateSchema = z
  .object({
    apiBase: z.string().url().max(500).optional(),
    apiKey: z.string().min(1).max(10_000),
    orgId: z.string().uuid().optional(),
    provider: ProviderSchema,
    scope: z.enum(['GLOBAL', 'ORGANIZATION', 'TEAM']),
    teamId: z.string().uuid().optional(),
  })
  .refine(
    (v) => {
      // Each scope requires exactly its own key and forbids the others.
      if (v.scope === 'GLOBAL') {
        return !v.teamId && !v.orgId;
      }
      if (v.scope === 'ORGANIZATION') {
        return !!v.orgId && !v.teamId;
      }
      return !!v.teamId && !v.orgId; // TEAM
    },
    {
      message:
        'scope=TEAM requires teamId; scope=ORGANIZATION requires orgId; scope=GLOBAL forbids both',
    }
  );

const CredentialUpdateSchema = z.object({
  apiBase: z.string().url().max(500).nullable().optional(),
  apiKey: z.string().min(1).max(10_000).optional(),
});

const IdParams = z.object({ id: z.string().uuid() });

const AuditQuery = z.object({
  entityId: z.string().uuid().optional(),
  entityType: z.enum(['Agent', 'ProviderCredential', 'EmbeddingConfig']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const EMBEDDING_CONFIG_SENTINEL_UUID = '00000000-0000-4000-a000-000000000001';

// ── Shared credential helpers (used by both admin and team-scoped plugins) ──

async function createCredentialAndAudit(
  fastify: FastifyInstance,
  actor: JwtPayload,
  reply: import('fastify').FastifyReply,
  input: Parameters<typeof createCredential>[1],
  messages: { conflict: (existingId: string) => string; conflictRace: string }
): Promise<unknown> {
  if (input.apiBase) {
    const safety = isSafeProbeUrl(input.apiBase);
    if (!safety.ok) {
      return reply.status(400).send({
        error: { code: 'UNSAFE_API_BASE', message: `apiBase rejected: ${safety.reason}` },
      });
    }
  }
  const result = await createCredential(fastify.prisma, input);
  if (result.outcome === 'conflict') {
    return reply.status(409).send({
      error: { code: 'CREDENTIAL_EXISTS', message: messages.conflict(result.existingId) },
    });
  }
  if (result.outcome === 'conflict_race') {
    return reply.status(409).send({
      error: { code: 'CREDENTIAL_EXISTS', message: messages.conflictRace },
    });
  }
  await writeAuditLog(fastify, {
    action: 'CREATE',
    actor,
    after: redactCredential(result.credential),
    entityId: result.credential.id,
    entityType: 'ProviderCredential',
  });
  return reply.status(201).send({ data: redactCredential(result.credential) });
}

async function updateCredentialAndAudit(
  fastify: FastifyInstance,
  actor: JwtPayload,
  reply: import('fastify').FastifyReply,
  existing: Parameters<typeof redactCredential>[0],
  body: { apiBase?: string | null; apiKey?: string }
): Promise<unknown> {
  if (body.apiBase) {
    const safety = isSafeProbeUrl(body.apiBase);
    if (!safety.ok) {
      return reply.status(400).send({
        error: { code: 'UNSAFE_API_BASE', message: `apiBase rejected: ${safety.reason}` },
      });
    }
  }
  const updated = await updateCredential(fastify.prisma, existing.id, body);
  await writeAuditLog(fastify, {
    action: 'UPDATE',
    actor,
    after: redactCredential(updated),
    before: redactCredential(existing),
    entityId: updated.id,
    entityType: 'ProviderCredential',
  });
  return { data: redactCredential(updated) };
}

async function deleteCredentialAndAudit(
  fastify: FastifyInstance,
  actor: JwtPayload,
  existing: Parameters<typeof redactCredential>[0]
): Promise<unknown> {
  await fastify.prisma.providerCredential.delete({ where: { id: existing.id } });
  await writeAuditLog(fastify, {
    action: 'DELETE',
    actor,
    before: redactCredential(existing),
    entityId: existing.id,
    entityType: 'ProviderCredential',
  });
  return { data: { deleted: true, id: existing.id } };
}

// ── Admin routes ──

export const modelConfigRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  // ── Provider credentials ───────────────────────────────────────────────

  app.get('/credentials', { onRequest: adminOnly }, async () => {
    const rows = await fastify.prisma.providerCredential.findMany({
      orderBy: [{ scope: 'asc' }, { provider: 'asc' }],
    });
    return { data: rows.map(redactCredential) };
  });

  app.post(
    '/credentials',
    { onRequest: adminOnly, schema: { body: CredentialCreateSchema } },
    async (request, reply) => {
      const actor = requireUser(request);
      const { provider, scope, teamId, orgId, apiBase, apiKey } = request.body;
      return createCredentialAndAudit(
        fastify,
        actor,
        reply,
        { actorId: actor.sub, apiBase, apiKey, orgId, provider, scope, teamId },
        {
          conflict: (existingId) =>
            `Credential for provider '${provider}' at scope '${scope}' already exists. Use PUT /credentials/${existingId} to update.`,
          conflictRace: `Credential for '${provider}' already exists at this scope (concurrent insert).`,
        }
      );
    }
  );

  app.put(
    '/credentials/:id',
    { onRequest: adminOnly, schema: { body: CredentialUpdateSchema, params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.providerCredential.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Credential not found' },
        });
      }
      return updateCredentialAndAudit(fastify, actor, reply, existing, request.body);
    }
  );

  app.delete(
    '/credentials/:id',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.providerCredential.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Credential not found' },
        });
      }
      return deleteCredentialAndAudit(fastify, actor, existing);
    }
  );

  /// Best-effort credential probe. Decrypts the key in-memory, issues a list-
  /// models HTTP request, returns the result. The plaintext key never leaves
  /// the process — only the HTTP status is returned to the caller.
  app.post(
    '/credentials/:id/test',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply): Promise<unknown> => {
      const cred = await fastify.prisma.providerCredential.findUnique({
        where: { id: request.params.id },
      });
      if (!cred) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Credential not found' } });
      }
      return { data: await testStoredCredential(cred) };
    }
  );

  // ── Audit log ──────────────────────────────────────────────────────────

  app.get(
    '/config-audit-log',
    { onRequest: adminOnly, schema: { querystring: AuditQuery } },
    async (request) => {
      const rows = await fastify.prisma.configAuditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: request.query.limit,
        where: {
          ...(request.query.entityType && { entityType: request.query.entityType }),
          ...(request.query.entityId && { entityId: request.query.entityId }),
        },
      });
      return { data: rows };
    }
  );

  // ── Embedding config (singleton) ─────────────────────────────────────────

  app.get('/embedding-config', { onRequest: adminOnly }, async () => {
    const row = await fastify.prisma.embeddingConfig.findUnique({
      include: { credential: { select: { id: true, lastFour: true, provider: true } } },
      where: { id: 'default' },
    });
    return { data: row };
  });

  /// Upserts the singleton EmbeddingConfig. Provider is parsed from the spec
  /// and verified — when the row pins a credentialId, the pinned credential's
  /// provider must match the spec's provider.
  app.put(
    '/embedding-config',
    {
      onRequest: adminOnly,
      schema: {
        body: z.object({
          credentialId: z.string().uuid().nullable().optional(),
          modelSpec: ModelSpecSchema,
        }),
      },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const { modelSpec, credentialId } = request.body;

      if (credentialId) {
        const cred = await fastify.prisma.providerCredential.findUnique({
          where: { id: credentialId },
        });
        if (!cred) {
          return reply.status(400).send({
            error: {
              code: 'CREDENTIAL_NOT_FOUND',
              message: `Credential ${credentialId} does not exist`,
            },
          });
        }
        const specProvider = modelSpec.split('/')[0]?.toLowerCase();
        if (specProvider && cred.provider !== specProvider) {
          return reply.status(400).send({
            error: {
              code: 'CREDENTIAL_PROVIDER_MISMATCH',
              message: `Credential is for provider '${cred.provider}' but spec is '${modelSpec}' (provider '${specProvider}'). Pick a matching credential.`,
            },
          });
        }
      }

      const { existing, updated } = await upsertEmbeddingConfig(fastify.prisma, {
        actorId: actor.sub,
        credentialId: credentialId ?? null,
        modelSpec,
      });
      await writeAuditLog(fastify, {
        action: existing ? 'UPDATE' : 'CREATE',
        actor,
        after: updated,
        before: existing ?? undefined,
        entityId: EMBEDDING_CONFIG_SENTINEL_UUID,
        entityType: 'EmbeddingConfig',
      });
      return { data: updated };
    }
  );
};

// ── Team-scoped credential routes (exported for `teams.ts` to mount) ───────

const TeamCredentialCreate = z.object({
  apiBase: z.string().url().max(500).optional(),
  apiKey: z.string().min(1).max(10_000),
  provider: ProviderSchema,
});

const TeamCredParams = z.object({ credId: z.string().uuid(), id: z.string().uuid() });

/**
 * Team-scoped credential management. Registered as a child plugin from
 * `teams.ts` so all team URLs share one `/api/v1/teams/:id` prefix. Permission
 * is `requiredTeamRole: 'ADMIN'` — team owners only. (Per-role model config is
 * now in the Agent library; team owners edit TEAM-scope agents there.)
 */
export const teamScopedConfigRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const teamAdmin = requireAuth({
    requiredRole: 'ENGINEER',
    requiredTeamRole: 'ADMIN',
    teamIdParam: 'id',
  });

  app.get(
    '/:id/credentials',
    { onRequest: teamAdmin, schema: { params: IdParams } },
    async (request) => {
      const rows = await fastify.prisma.providerCredential.findMany({
        orderBy: { provider: 'asc' },
        where: { scope: 'TEAM', teamId: request.params.id },
      });
      return { data: rows.map(redactCredential) };
    }
  );

  /// Every credential a team owner may pin: their own TEAM creds + all GLOBAL.
  app.get(
    '/:id/accessible-credentials',
    { onRequest: teamAdmin, schema: { params: IdParams } },
    async (request) => {
      const rows = await fastify.prisma.providerCredential.findMany({
        orderBy: [{ scope: 'asc' }, { provider: 'asc' }],
        where: {
          OR: [{ scope: 'GLOBAL' }, { scope: 'TEAM', teamId: request.params.id }],
        },
      });
      return { data: rows.map(redactCredential) };
    }
  );

  app.post(
    '/:id/credentials',
    { onRequest: teamAdmin, schema: { body: TeamCredentialCreate, params: IdParams } },
    async (request, reply): Promise<unknown> => {
      const actor = requireUser(request);
      const { provider, apiBase, apiKey } = request.body;
      return createCredentialAndAudit(
        fastify,
        actor,
        reply,
        { actorId: actor.sub, apiBase, apiKey, provider, scope: 'TEAM', teamId: request.params.id },
        {
          conflict: () => `Credential for '${provider}' already exists for this team`,
          conflictRace: `Credential for '${provider}' already exists for this team (concurrent insert).`,
        }
      );
    }
  );

  app.put(
    '/:id/credentials/:credId',
    { onRequest: teamAdmin, schema: { body: CredentialUpdateSchema, params: TeamCredParams } },
    async (request, reply): Promise<unknown> => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.providerCredential.findUnique({
        where: { id: request.params.credId },
      });
      if (!existing || existing.teamId !== request.params.id || existing.scope !== 'TEAM') {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Credential not found for this team' } });
      }
      return updateCredentialAndAudit(fastify, actor, reply, existing, request.body);
    }
  );

  app.delete(
    '/:id/credentials/:credId',
    { onRequest: teamAdmin, schema: { params: TeamCredParams } },
    async (request, reply): Promise<unknown> => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.providerCredential.findUnique({
        where: { id: request.params.credId },
      });
      if (!existing || existing.teamId !== request.params.id || existing.scope !== 'TEAM') {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Credential not found for this team' } });
      }
      return deleteCredentialAndAudit(fastify, actor, existing);
    }
  );
};
