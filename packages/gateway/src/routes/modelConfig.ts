import {
  type CoverageGap,
  gapsOpenedByRemoving,
  loadCoverageInput,
} from '@auto-swe/shared/lib/credentialCoverage';
import { isPrivateHostListed, resolvePrivateModelHosts } from '@auto-swe/shared/lib/modelDiscovery';
import { embeddingProviderProblem, parseProviderModelSpec } from '@auto-swe/shared/lib/modelSpec';
import { checkProbeUrl } from '@auto-swe/shared/lib/ssrfGuard';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import {
  BUILTIN_PROVIDERS,
  createCredential,
  credentialInputProblem,
  redactCredential,
  testStoredCredential,
  updateCredential,
} from '../lib/credentialService.js';
import { catalogWarnings } from '../lib/modelCatalogService.js';
import { upsertEmbeddingConfig } from '../lib/modelConfigService.js';
import { ModelSpecSchema } from '../lib/modelSpecSchema.js';
import { booleanQueryParam } from '../lib/queryParams.js';
import { type JwtPayload, requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Admin routes for provider credentials + the embedding-model singleton. Per-role model/prompt config moved to the Agent
 * library (`/api/v1/platform/agent-library`) in P1.5 — see `agentLibrary.ts`.
 *
 * Team-scoped credential variants live in `teamScopedConfigRoutes` (mounted by
 * `teams.ts`). Business logic lives in `lib/credentialService.ts` +
 * `lib/modelConfigService.ts`.
 */

// ── Validation schemas ──

const ProviderSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'provider must be lowercase-kebab-case');

const CredentialCreateSchema = z
  .object({
    apiBase: z.string().trim().url().max(500).optional(),
    apiKey: z.string().trim().min(1).max(10_000),
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
  apiBase: z.string().trim().url().max(500).nullable().optional(),
  apiKey: z.string().trim().min(1).max(10_000).optional(),
});

const IdParams = z.object({ id: z.string().uuid() });

/** `?force=true` deletes a credential even though agents depend on it. */
const DeleteQuery = z.object({ force: booleanQueryParam(false) });

const EMBEDDING_CONFIG_SENTINEL_UUID = '00000000-0000-4000-a000-000000000001';

// ── Shared credential helpers (used by both admin and team-scoped plugins) ──

async function createCredentialAndAudit(
  fastify: FastifyInstance,
  actor: JwtPayload,
  reply: import('fastify').FastifyReply,
  input: Parameters<typeof createCredential>[1],
  messages: { conflict: (existingId: string) => string; conflictRace: string }
): Promise<unknown> {
  const problem = credentialInputProblem(input);
  if (problem) {
    return reply.status(400).send({ error: { code: 'INVALID_CREDENTIAL', message: problem } });
  }
  if (input.apiBase) {
    const safety = checkProbeUrl(input.apiBase, {
      allowPrivate: isPrivateHostListed(input.apiBase, await resolvePrivateModelHosts()),
    });
    if (!safety.ok) {
      return reply.status(400).send({
        error: { code: 'UNSAFE_API_BASE', message: `apiBase rejected: ${safety.reason}` },
      });
    }
  }
  if (!BUILTIN_PROVIDERS.includes(input.provider) && !input.apiBase) {
    return reply.status(400).send({
      error: {
        code: 'API_BASE_REQUIRED',
        message: `Provider '${input.provider}' is not built in, so it needs an API base URL`,
      },
    });
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
  const problem = credentialInputProblem(body);
  if (problem) {
    return reply.status(400).send({ error: { code: 'INVALID_CREDENTIAL', message: problem } });
  }
  if (body.apiBase) {
    const safety = checkProbeUrl(body.apiBase, {
      allowPrivate: isPrivateHostListed(body.apiBase, await resolvePrivateModelHosts()),
    });
    if (!safety.ok) {
      return reply.status(400).send({
        error: { code: 'UNSAFE_API_BASE', message: `apiBase rejected: ${safety.reason}` },
      });
    }
  }
  if (!BUILTIN_PROVIDERS.includes(existing.provider) && body.apiBase === null) {
    return reply.status(400).send({
      error: {
        code: 'API_BASE_REQUIRED',
        message: `Provider '${existing.provider}' is not built in, so its API base URL cannot be cleared`,
      },
    });
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

/** A gap as the API reports it: what would stop working, never a credential detail. */
function dependentOf(gap: CoverageGap) {
  return {
    detail: gap.detail,
    orgId: gap.orgId,
    problem: gap.problem,
    scope: gap.scope,
    subject: gap.subject,
    teamId: gap.teamId,
  };
}

/**
 * Deletes a credential, unless doing so would leave an agent or the embedding
 * model with no credential it can use — then `409 CREDENTIAL_IN_USE` lists them,
 * and `force` deletes anyway. `visible` narrows what may block (and be named) to
 * what the caller may see: a team admin is refused only over its own team's agents.
 */
async function deleteCredentialAndAudit(
  fastify: FastifyInstance,
  actor: JwtPayload,
  reply: FastifyReply,
  existing: Parameters<typeof redactCredential>[0],
  opts: { force: boolean; visible?: (gap: CoverageGap) => boolean }
): Promise<unknown> {
  const opened = gapsOpenedByRemoving(await loadCoverageInput(fastify.prisma), existing.id).filter(
    (gap) => opts.visible?.(gap) ?? true
  );
  if (opened.length > 0 && !opts.force) {
    return reply.status(409).send({
      error: {
        code: 'CREDENTIAL_IN_USE',
        dependents: opened.map(dependentOf),
        message: `Deleting this ${existing.provider} credential leaves ${opened.length} ${opened.length === 1 ? 'dependent' : 'dependents'} with no credential: ${opened.map((g) => g.subject).join(', ')}. Pass force=true to delete it anyway.`,
      },
    });
  }
  await fastify.prisma.providerCredential.delete({ where: { id: existing.id } });
  await writeAuditLog(fastify, {
    action: 'DELETE',
    actor,
    // What the forced delete left uncovered, so the audit says why runs started failing.
    ...(opened.length > 0 ? { after: { leftWithoutCredential: opened.map(dependentOf) } } : {}),
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
    // Deliberately every scope: this page is where an admin sees which teams
    // and orgs have their own credentials, so filtering it would hide the point.
    const rows = await runUnscoped(
      'admin credential listing spans every scope',
      ['ProviderCredential'],
      () =>
        fastify.prisma.providerCredential.findMany({
          orderBy: [{ scope: 'asc' }, { provider: 'asc' }],
        })
    );
    // What each credential backs, so the delete confirmation can say what stops working.
    const ids = rows.map((r) => r.id);
    const [agentRows, embedding] =
      ids.length === 0
        ? [[], null]
        : await runUnscoped(
            'credential usage spans every scope',
            ['Agent', 'EmbeddingConfig'],
            () =>
              Promise.all([
                fastify.prisma.agent.findMany({
                  select: { credentialId: true, key: true },
                  where: { credentialId: { in: ids }, isActive: true },
                }),
                fastify.prisma.embeddingConfig.findFirst({
                  select: { credentialId: true },
                  where: { credentialId: { in: ids } },
                }),
              ])
          );
    // What deleting each one would leave with no credential at all, for the confirmation.
    const coverage = rows.length === 0 ? null : await loadCoverageInput(fastify.prisma);
    return {
      data: rows.map((row) => ({
        ...redactCredential(row),
        usage: {
          agents: [
            ...new Set(agentRows.filter((a) => a.credentialId === row.id).map((a) => a.key)),
          ].sort(),
          embedding: embedding?.credentialId === row.id,
          leavesWithoutCredential: coverage
            ? gapsOpenedByRemoving(coverage, row.id).map(dependentOf)
            : [],
        },
      })),
    };
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
    { onRequest: adminOnly, schema: { params: IdParams, querystring: DeleteQuery } },
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
      return deleteCredentialAndAudit(fastify, actor, reply, existing, {
        force: request.query.force,
      });
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
      const embedProblem = embeddingProviderProblem(parseProviderModelSpec(modelSpec).provider);
      if (embedProblem) {
        return reply
          .status(400)
          .send({ error: { code: 'EMBEDDING_PROVIDER_UNSUPPORTED', message: embedProblem } });
      }

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
      const warnings = await catalogWarnings(fastify.prisma, modelSpec, 'EMBEDDING');
      return { data: updated, ...(warnings.length > 0 ? { catalogWarnings: warnings } : {}) };
    }
  );

  // ── Re-embed memory after a model change ─────────────────────────────────
  //
  // Recall and consolidation only compare vectors from one model, so after the
  // embedding model changes every older row drops out of both until it is
  // re-embedded. These report how many rows that is and start the bulk walk.

  /** Rows the configured model did not embed: another model's, or legacy unlabelled ones. */
  async function countStaleMemory(modelSpec: string | null) {
    return runUnscoped('memory-wide re-embed status spans every team', ['MemoryItem'], () =>
      Promise.all([
        fastify.prisma.memoryItem.count(),
        modelSpec
          ? fastify.prisma.memoryItem.count({
              where: { OR: [{ embeddingModel: null }, { embeddingModel: { not: modelSpec } }] },
            })
          : fastify.prisma.memoryItem.count(),
      ])
    );
  }

  app.get('/embedding-config/reembed', { onRequest: adminOnly }, async () => {
    const config = await fastify.prisma.embeddingConfig.findUnique({
      select: { modelSpec: true },
      where: { id: 'default' },
    });
    const modelSpec = config?.modelSpec ?? null;
    const [[total, stale], running] = await Promise.all([
      countStaleMemory(modelSpec),
      fastify.temporal.isReembedStaleMemoryRunning(),
    ]);
    return { data: { modelSpec, running, stale, total } };
  });

  app.post('/embedding-config/reembed', { onRequest: adminOnly }, async (request, reply) => {
    const actor = requireUser(request);
    const config = await fastify.prisma.embeddingConfig.findUnique({
      select: { modelSpec: true },
      where: { id: 'default' },
    });
    if (!config) {
      return reply.status(409).send({
        error: {
          code: 'NO_EMBEDDING_CONFIG',
          message: 'Configure an embedding model before re-embedding memory.',
        },
      });
    }
    const [, stale] = await countStaleMemory(config.modelSpec);
    const started = await fastify.temporal.startReembedStaleMemory();
    if (!started) {
      return reply.status(409).send({
        error: { code: 'REEMBED_IN_PROGRESS', message: 'A memory re-embed is already running.' },
      });
    }
    // Every stale row costs one embedding call, so who started it is recorded.
    await writeAuditLog(fastify, {
      action: 'UPDATE',
      actor,
      after: { reembedStarted: true, staleRows: stale },
      entityId: EMBEDDING_CONFIG_SENTINEL_UUID,
      entityType: 'EmbeddingConfig',
    });
    return reply.status(202).send({ data: { staleRows: stale, started: true } });
  });
};

// ── Team-scoped credential routes (exported for `teams.ts` to mount) ───────

const TeamCredentialCreate = z.object({
  apiBase: z.string().trim().url().max(500).optional(),
  apiKey: z.string().trim().min(1).max(10_000),
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
    { onRequest: teamAdmin, schema: { params: TeamCredParams, querystring: DeleteQuery } },
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
      const teamId = request.params.id;
      return deleteCredentialAndAudit(fastify, actor, reply, existing, {
        force: request.query.force,
        visible: (gap) => gap.scope === 'TEAM' && gap.teamId === teamId,
      });
    }
  );
};
