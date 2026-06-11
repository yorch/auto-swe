import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import {
  createCredential,
  redactCredential,
  testStoredCredential,
  updateCredential,
} from '../lib/credentialService.js';
import {
  getEffectiveModelConfig,
  MODEL_AGENT_ROLES,
  MODEL_CONFIG_SCOPES,
  type ModelRoleConfigUpsertInput,
  seedDefaultModelConfigs,
  upsertEmbeddingConfig,
  upsertModelRoleConfig,
} from '../lib/modelConfigService.js';
import { type JwtPayload, requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Phase-3 admin routes for LLM model configuration. These routes manage:
 * - `ModelRoleConfig` rows — per-role `<provider>/<model-id>` specs at any
 *   scope (GLOBAL / TEAM / WORKFLOW_TEMPLATE).
 * - `ProviderCredential` rows — encrypted apiKey + optional apiBase, scoped
 *   GLOBAL or TEAM only.
 * - `ConfigAuditLog` reads.
 *
 * Team-scoped variants of these routes live in `teams.ts` (consistent with
 * how `shellImageAllowlist` is wired). All routes here require platform
 * ADMIN role. Business logic lives in `lib/modelConfigService.ts` and
 * `lib/credentialService.ts` — the admin and team-scoped plugins below call
 * the same service functions, parameterized by scope.
 */

// ── Validation schemas ──

const ModelSpecSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[^/\s]+\/.+$/, 'must be <provider>/<model-id>');

const UpsertModelRoleConfigSchema = z
  .object({
    credentialId: z.string().uuid().nullable().optional(),
    modelSpec: ModelSpecSchema,
    role: z.enum(MODEL_AGENT_ROLES),
    scope: z.enum(MODEL_CONFIG_SCOPES),
    systemPrompt: z.string().max(50_000).nullable().optional(),
    teamId: z.string().uuid().optional(),
    workflowTemplateId: z.string().uuid().optional(),
  })
  .refine(
    (v) =>
      (v.scope === 'GLOBAL' && !v.teamId && !v.workflowTemplateId) ||
      (v.scope === 'TEAM' && !!v.teamId && !v.workflowTemplateId) ||
      (v.scope === 'WORKFLOW_TEMPLATE' && !v.teamId && !!v.workflowTemplateId),
    {
      message:
        'scope=TEAM requires teamId only; scope=WORKFLOW_TEMPLATE requires workflowTemplateId only; scope=GLOBAL forbids both',
    }
  );

const ProviderSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'provider must be lowercase-kebab-case');

const CredentialCreateSchema = z
  .object({
    apiBase: z.string().url().max(500).optional(),
    apiKey: z.string().min(1).max(10_000),
    provider: ProviderSchema,
    scope: z.enum(['GLOBAL', 'TEAM']),
    teamId: z.string().uuid().optional(),
  })
  .refine((v) => (v.scope === 'GLOBAL' ? !v.teamId : !!v.teamId), {
    message: 'scope=TEAM requires teamId; scope=GLOBAL forbids it',
  });

const CredentialUpdateSchema = z.object({
  apiBase: z.string().url().max(500).nullable().optional(),
  apiKey: z.string().min(1).max(10_000).optional(),
});

const ListConfigQuery = z.object({
  scope: z.enum(MODEL_CONFIG_SCOPES).optional(),
  teamId: z.string().uuid().optional(),
  workflowTemplateId: z.string().uuid().optional(),
});

const EffectiveQuery = z.object({
  role: z.enum(MODEL_AGENT_ROLES),
  teamId: z.string().uuid().optional(),
  workflowTemplateId: z.string().uuid().optional(),
});

const IdParams = z.object({ id: z.string().uuid() });

const AuditQuery = z.object({
  entityId: z.string().uuid().optional(),
  entityType: z.enum(['ModelRoleConfig', 'ProviderCredential', 'EmbeddingConfig']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const EMBEDDING_CONFIG_SENTINEL_UUID = '00000000-0000-4000-a000-000000000001';

// ── Shared route helpers (used by both admin and team-scoped plugins) ──

/// Upserts via the service, writes the audit entry, and replies 201 on create
/// / 200 on update — the shared tail of both PUT model-config routes.
async function upsertModelRoleConfigAndAudit(
  fastify: FastifyInstance,
  actor: JwtPayload,
  reply: FastifyReply,
  input: ModelRoleConfigUpsertInput
): Promise<unknown> {
  const result = await upsertModelRoleConfig(fastify.prisma, input);
  await writeAuditLog(fastify, {
    action: result.action,
    actor,
    after: result.row,
    before: result.before,
    entityId: result.row.id,
    entityType: 'ModelRoleConfig',
  });
  if (result.action === 'CREATE') {
    return reply.status(201).send({ data: result.row });
  }
  return { data: result.row };
}

/// Creates a credential via the service, mapping conflicts to 409 with
/// caller-supplied messages, and audit-logs + 201s the redacted row.
async function createCredentialAndAudit(
  fastify: FastifyInstance,
  actor: JwtPayload,
  reply: FastifyReply,
  input: Parameters<typeof createCredential>[1],
  messages: { conflict: (existingId: string) => string; conflictRace: string }
): Promise<unknown> {
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

/// Applies a credential update via the service and audit-logs it. Existence /
/// ownership checks are done by the caller before invoking this.
async function updateCredentialAndAudit(
  fastify: FastifyInstance,
  actor: JwtPayload,
  existing: Parameters<typeof redactCredential>[0],
  body: { apiBase?: string | null; apiKey?: string }
): Promise<unknown> {
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

/// Deletes a credential row and audit-logs it (shared by admin + team routes).
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

// ── Routes ──

export const modelConfigRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  // ── Model role configs ─────────────────────────────────────────────────

  app.get(
    '/model-config',
    { onRequest: adminOnly, schema: { querystring: ListConfigQuery } },
    async (request) => {
      const rows = await fastify.prisma.modelRoleConfig.findMany({
        include: { credential: { select: { id: true, lastFour: true, provider: true } } },
        orderBy: [{ scope: 'asc' }, { role: 'asc' }],
        where: {
          ...(request.query.scope && { scope: request.query.scope }),
          ...(request.query.teamId && { teamId: request.query.teamId }),
          ...(request.query.workflowTemplateId && {
            workflowTemplateId: request.query.workflowTemplateId,
          }),
        },
      });
      return { data: rows };
    }
  );

  /// Upsert: server resolves the unique key from `(role, scope, teamId?, workflowTemplateId?)`.
  /// Used by the UI as the single "save" endpoint — clients don't have to
  /// distinguish create vs update.
  app.put(
    '/model-config',
    { onRequest: adminOnly, schema: { body: UpsertModelRoleConfigSchema } },
    async (request, reply) => {
      const actor = requireUser(request);
      const { role, scope, teamId, workflowTemplateId, modelSpec, credentialId, systemPrompt } =
        request.body;

      // Pinned credentials must reference an existing row.
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
      }

      return upsertModelRoleConfigAndAudit(fastify, actor, reply, {
        actorId: actor.sub,
        credentialId: credentialId ?? null,
        modelSpec,
        role,
        scope,
        systemPrompt: systemPrompt?.trim() || null,
        teamId: scope === 'TEAM' ? (teamId ?? null) : null,
        workflowTemplateId: scope === 'WORKFLOW_TEMPLATE' ? (workflowTemplateId ?? null) : null,
      });
    }
  );

  app.delete(
    '/model-config/:id',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const row = await fastify.prisma.modelRoleConfig.findUnique({
        where: { id: request.params.id },
      });
      if (!row) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Model role config not found' },
        });
      }
      if (row.scope === 'GLOBAL') {
        return reply.status(400).send({
          error: {
            code: 'CANNOT_DELETE_GLOBAL',
            message:
              'GLOBAL rows are the system-wide default and cannot be deleted, only updated. Edit the modelSpec instead.',
          },
        });
      }
      await fastify.prisma.modelRoleConfig.delete({ where: { id: row.id } });
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor,
        before: row,
        entityId: row.id,
        entityType: 'ModelRoleConfig',
      });
      return { data: { deleted: true, id: row.id } };
    }
  );

  /// Returns which scope row would win for `(role, teamId?, workflowTemplateId?)`.
  /// Lets the UI preview the cascade without users having to mentally
  /// re-run the resolver.
  app.get(
    '/model-config/effective',
    { onRequest: adminOnly, schema: { querystring: EffectiveQuery } },
    async (request) => ({ data: await getEffectiveModelConfig(fastify.prisma, request.query) })
  );

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
      const { provider, scope, teamId, apiBase, apiKey } = request.body;
      return createCredentialAndAudit(
        fastify,
        actor,
        reply,
        { actorId: actor.sub, apiBase, apiKey, provider, scope, teamId },
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
    {
      onRequest: adminOnly,
      schema: { body: CredentialUpdateSchema, params: IdParams },
    },
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
      return updateCredentialAndAudit(fastify, actor, existing, request.body);
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
  /// provider must match the spec's provider (mirrors the assertConfigReady
  /// invariant; would otherwise surface as a 401 at the next embedding call).
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
        // Provider-match guard. The worker's assertConfigReady would also
        // catch this on next boot, but failing fast at write time gives
        // operators the error before they restart.
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
        // EmbeddingConfig uses a literal string id, but ConfigAuditLog.entityId
        // is UUID. We tag the audit entry with a sentinel UUID so audit-log
        // readers can still group by entity. The mapping is one-to-one since
        // the table is a singleton.
        entityId: EMBEDDING_CONFIG_SENTINEL_UUID,
        entityType: 'EmbeddingConfig',
      });
      return { data: updated };
    }
  );

  /// One-click admin bootstrap: seeds GLOBAL ModelRoleConfig rows + the
  /// EmbeddingConfig singleton from the baked-in defaults. Idempotent.
  app.post('/defaults', { onRequest: adminOnly }, async (request) => {
    const actor = requireUser(request);
    const data = await seedDefaultModelConfigs(fastify.prisma, actor.sub, async (created) => {
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor,
        after: created,
        entityId: created.id,
        entityType: 'ModelRoleConfig',
      });
    });
    return { data };
  });
};

// ── Team-scoped route helpers (exported for `teams.ts` to mount) ───────────

const TeamModelConfigUpsert = z.object({
  credentialId: z.string().uuid().nullable().optional(),
  modelSpec: ModelSpecSchema,
  role: z.enum(MODEL_AGENT_ROLES),
  systemPrompt: z.string().max(50_000).nullable().optional(),
});

const TeamCredentialCreate = z.object({
  apiBase: z.string().url().max(500).optional(),
  apiKey: z.string().min(1).max(10_000),
  provider: ProviderSchema,
});

const TeamRoleParams = z.object({ configId: z.string().uuid(), id: z.string().uuid() });
const TeamCredParams = z.object({ credId: z.string().uuid(), id: z.string().uuid() });

/**
 * Mounts the team-scoped variants. Registered as a child plugin from
 * `teams.ts` so all team URLs share one `/api/v1/teams/:id` prefix and the
 * routes inherit the parent plugin's hooks/decorators. Permission is
 * `requiredTeamRole: 'ADMIN'` — team owners only.
 */
export const teamScopedConfigRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const teamAdmin = requireAuth({
    requiredRole: 'ENGINEER',
    requiredTeamRole: 'ADMIN',
    teamIdParam: 'id',
  });

  app.get(
    '/:id/model-config',
    { onRequest: teamAdmin, schema: { params: IdParams } },
    async (request) => {
      const rows = await fastify.prisma.modelRoleConfig.findMany({
        include: { credential: { select: { id: true, lastFour: true, provider: true } } },
        orderBy: { role: 'asc' },
        where: { scope: 'TEAM', teamId: request.params.id },
      });
      return { data: rows };
    }
  );

  app.put(
    '/:id/model-config',
    { onRequest: teamAdmin, schema: { body: TeamModelConfigUpsert, params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const { role, modelSpec, credentialId, systemPrompt } = request.body;
      if (credentialId) {
        const cred = await fastify.prisma.providerCredential.findUnique({
          where: { id: credentialId },
        });
        // Team owners may only reference GLOBAL or their own TEAM credentials.
        if (!cred || (cred.scope === 'TEAM' && cred.teamId !== request.params.id)) {
          return reply.status(400).send({
            error: {
              code: 'CREDENTIAL_NOT_ACCESSIBLE',
              message: 'Credential not found or belongs to a different team',
            },
          });
        }
      }
      return upsertModelRoleConfigAndAudit(fastify, actor, reply, {
        actorId: actor.sub,
        credentialId: credentialId ?? null,
        modelSpec,
        role,
        scope: 'TEAM',
        systemPrompt: systemPrompt?.trim() || null,
        teamId: request.params.id,
        workflowTemplateId: null,
      });
    }
  );

  app.delete(
    '/:id/model-config/:configId',
    { onRequest: teamAdmin, schema: { params: TeamRoleParams } },
    async (request, reply): Promise<unknown> => {
      const actor = requireUser(request);
      const row = await fastify.prisma.modelRoleConfig.findUnique({
        where: { id: request.params.configId },
      });
      if (!row || row.teamId !== request.params.id || row.scope !== 'TEAM') {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Override not found for this team' } });
      }
      await fastify.prisma.modelRoleConfig.delete({ where: { id: row.id } });
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor,
        before: row,
        entityId: row.id,
        entityType: 'ModelRoleConfig',
      });
      return { data: { deleted: true, id: row.id } };
    }
  );

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

  /// Returns every credential a team owner is allowed to PIN on a model
  /// role config: their own TEAM-scope credentials plus all GLOBAL-scope
  /// credentials. Lets the team dashboard populate its "Pin credential"
  /// dropdown without hitting /api/v1/admin/credentials (which requires
  /// platform-ADMIN role and returns 403 for team owners). The platform-
  /// ADMIN gateway invariant — that team owners CAN pin GLOBAL credentials
  /// — is enforced server-side in PUT /:id/model-config (modelConfig.ts).
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
      return updateCredentialAndAudit(fastify, actor, existing, request.body);
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
