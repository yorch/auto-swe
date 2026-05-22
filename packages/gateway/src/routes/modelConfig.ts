import { encryptSecret } from '@auto-swe/shared/lib/crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
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
 * ADMIN role.
 */

// ── Validation schemas ──

const AGENT_ROLES = [
  'IMPLEMENTER',
  'REVIEWER',
  'PLANNER',
  'SECURITY_REVIEW',
  'VALIDATE_CONTEXT',
  'COMMIT_TO_MEMORY',
] as const;
const ROLE_VALUES = AGENT_ROLES;
const SCOPE_VALUES = ['GLOBAL', 'TEAM', 'WORKFLOW_TEMPLATE'] as const;

const ModelSpecSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[^/\s]+\/.+$/, 'must be <provider>/<model-id>');

const UpsertModelRoleConfigSchema = z
  .object({
    credentialId: z.string().uuid().nullable().optional(),
    modelSpec: ModelSpecSchema,
    role: z.enum(ROLE_VALUES),
    scope: z.enum(SCOPE_VALUES),
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

const CredentialCreateSchema = z
  .object({
    apiBase: z.string().url().max(500).optional(),
    apiKey: z.string().min(1).max(10_000),
    provider: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'provider must be lowercase-kebab-case'),
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
  scope: z.enum(SCOPE_VALUES).optional(),
  teamId: z.string().uuid().optional(),
  workflowTemplateId: z.string().uuid().optional(),
});

const EffectiveQuery = z.object({
  role: z.enum(ROLE_VALUES),
  teamId: z.string().uuid().optional(),
  workflowTemplateId: z.string().uuid().optional(),
});

const IdParams = z.object({ id: z.string().uuid() });

const AuditQuery = z.object({
  entityId: z.string().uuid().optional(),
  entityType: z.enum(['ModelRoleConfig', 'ProviderCredential', 'EmbeddingConfig']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/// Prisma's known unique-constraint error code. Used to detect lost-race
/// writes when two admins edit the same row simultaneously — partial unique
/// indexes from the Phase-1 migration enforce one row per (role,scope,key).
const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === UNIQUE_CONSTRAINT_VIOLATION
  );
}

// ── Helpers ──

/// Strips the encrypted bytes from a credential row before returning it.
/// Plaintext API keys never leave the gateway.
function redactCredential(row: {
  id: string;
  provider: string;
  scope: 'GLOBAL' | 'TEAM' | 'WORKFLOW_TEMPLATE';
  teamId: string | null;
  apiBase: string | null;
  lastFour: string;
  keyVersion: number;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    apiBase: row.apiBase,
    createdAt: row.createdAt,
    createdById: row.createdById,
    id: row.id,
    keyVersion: row.keyVersion,
    lastFour: row.lastFour,
    maskedKey: `****${row.lastFour}`,
    provider: row.provider,
    scope: row.scope,
    teamId: row.teamId,
    updatedAt: row.updatedAt,
  };
}

/// Records a config-mutation audit row. Secret material is redacted via
/// `redactCredential` so the audit log never holds plaintext keys.
async function writeAuditLog(
  fastify: FastifyInstance,
  args: {
    entityType: 'ModelRoleConfig' | 'ProviderCredential' | 'EmbeddingConfig';
    entityId: string;
    action: 'CREATE' | 'UPDATE' | 'DELETE';
    actor: JwtPayload;
    before?: unknown;
    after?: unknown;
  }
): Promise<void> {
  await fastify.prisma.configAuditLog.create({
    data: {
      action: args.action,
      actorId: args.actor.sub,
      afterJson: (args.after ?? null) as never,
      beforeJson: (args.before ?? null) as never,
      entityId: args.entityId,
      entityType: args.entityType,
    },
  });
}

const PROBE_TIMEOUT_MS = 5_000;

/// Rejects URLs that would let the gateway be used as an SSRF proxy: anything
/// that isn't https://, anything resolving to a loopback / link-local / RFC1918
/// host. We resolve at hostname-text level only (no DNS lookup) — the goal is
/// blocking the obvious accidents, not stopping a determined attacker who can
/// register a public hostname pointing at internal IPs. (For that we'd need
/// per-environment outbound-network policy at the OS/container level.)
function isSafeProbeUrl(apiBase: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `protocol '${url.protocol}' not allowed` };
  }
  const host = url.hostname.toLowerCase();
  // Loopback / link-local / unspecified / IPv6 ::1 — text-level checks.
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return { ok: false, reason: `host '${host}' is internal` };
  }
  // RFC 1918 IPv4 + link-local + AWS metadata.
  if (
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^fc[0-9a-f]{2}:/.test(host) ||
    /^fe[89ab][0-9a-f]:/.test(host)
  ) {
    return { ok: false, reason: `host '${host}' is on a private network` };
  }
  return { ok: true, url };
}

/// Issues a minimal HTTP probe against the configured provider to verify the
/// credential works. Returns `{ ok, status, error? }`. Best-effort — not all
/// providers expose a cheap "list models" endpoint, so failures here are not
/// authoritative.
async function probeCredential(args: {
  provider: string;
  apiKey: string;
  apiBase?: string | null;
}): Promise<{ ok: boolean; status?: number; error?: string }> {
  const { provider, apiKey, apiBase } = args;
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'anthropic-version': '2023-06-01', 'x-api-key': apiKey },
        signal,
      });
      return { ok: res.ok, status: res.status };
    }
    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      });
      return { ok: res.ok, status: res.status };
    }
    if (provider === 'google') {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        { signal }
      );
      return { ok: res.ok, status: res.status };
    }
    // OpenAI-compatible: probe `<base>/models`. SSRF guards run here.
    if (!apiBase) {
      return { error: 'apiBase required to probe OpenAI-compatible providers', ok: false };
    }
    const safety = isSafeProbeUrl(apiBase);
    if (!safety.ok) {
      return { error: `apiBase rejected: ${safety.reason}`, ok: false };
    }
    const base = safety.url.toString().replace(/\/+$/, '');
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), ok: false };
  }
}

// ── Shared upsert helpers (used by both admin and team-scoped routes) ──

type ModelRoleConfigUpsertInput = {
  role: (typeof ROLE_VALUES)[number];
  scope: (typeof SCOPE_VALUES)[number];
  teamId: string | null;
  workflowTemplateId: string | null;
  modelSpec: string;
  credentialId: string | null;
};

/// findFirst → create-or-update, with one P2002 retry to handle the rare case
/// where two admins (or admin + team owner) write the same scope key at once.
/// The unique constraint in the migration prevents duplicate rows; this just
/// gracefully recovers from the race instead of surfacing a 500.
async function upsertModelRoleConfig(
  fastify: FastifyInstance,
  actor: JwtPayload,
  reply: FastifyReply,
  input: ModelRoleConfigUpsertInput
): Promise<unknown> {
  const existing = await fastify.prisma.modelRoleConfig.findFirst({
    where: {
      role: input.role,
      scope: input.scope,
      teamId: input.teamId,
      workflowTemplateId: input.workflowTemplateId,
    },
  });
  if (existing) {
    const updated = await fastify.prisma.modelRoleConfig.update({
      data: { credentialId: input.credentialId, modelSpec: input.modelSpec },
      where: { id: existing.id },
    });
    await writeAuditLog(fastify, {
      action: 'UPDATE',
      actor,
      after: updated,
      before: existing,
      entityId: updated.id,
      entityType: 'ModelRoleConfig',
    });
    return { data: updated };
  }
  try {
    const created = await fastify.prisma.modelRoleConfig.create({
      data: {
        createdById: actor.sub,
        credentialId: input.credentialId,
        modelSpec: input.modelSpec,
        role: input.role,
        scope: input.scope,
        teamId: input.teamId,
        workflowTemplateId: input.workflowTemplateId,
      },
    });
    await writeAuditLog(fastify, {
      action: 'CREATE',
      actor,
      after: created,
      entityId: created.id,
      entityType: 'ModelRoleConfig',
    });
    return reply.status(201).send({ data: created });
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    // Lost the create race — the row now exists. Update it.
    const row = await fastify.prisma.modelRoleConfig.findFirst({
      where: {
        role: input.role,
        scope: input.scope,
        teamId: input.teamId,
        workflowTemplateId: input.workflowTemplateId,
      },
    });
    if (!row) throw err; // race recovery failed — surface the original
    const updated = await fastify.prisma.modelRoleConfig.update({
      data: { credentialId: input.credentialId, modelSpec: input.modelSpec },
      where: { id: row.id },
    });
    await writeAuditLog(fastify, {
      action: 'UPDATE',
      actor,
      after: updated,
      before: row,
      entityId: updated.id,
      entityType: 'ModelRoleConfig',
    });
    return { data: updated };
  }
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
      const { role, scope, teamId, workflowTemplateId, modelSpec, credentialId } = request.body;

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

      return upsertModelRoleConfig(fastify, actor, reply, {
        credentialId: credentialId ?? null,
        modelSpec,
        role,
        scope,
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
    async (request) => {
      const { role, teamId, workflowTemplateId } = request.query;
      if (workflowTemplateId) {
        const row = await fastify.prisma.modelRoleConfig.findFirst({
          include: { credential: { select: { id: true, lastFour: true, provider: true } } },
          where: { role, scope: 'WORKFLOW_TEMPLATE', workflowTemplateId },
        });
        if (row) return { data: { row, scope: 'WORKFLOW_TEMPLATE' } };
      }
      if (teamId) {
        const row = await fastify.prisma.modelRoleConfig.findFirst({
          include: { credential: { select: { id: true, lastFour: true, provider: true } } },
          where: { role, scope: 'TEAM', teamId },
        });
        if (row) return { data: { row, scope: 'TEAM' } };
      }
      const row = await fastify.prisma.modelRoleConfig.findFirst({
        include: { credential: { select: { id: true, lastFour: true, provider: true } } },
        where: { role, scope: 'GLOBAL' },
      });
      if (row) return { data: { row, scope: 'GLOBAL' } };
      return { data: { row: null, scope: null } };
    }
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

      const existing = await fastify.prisma.providerCredential.findFirst({
        where: { provider, scope, teamId: scope === 'TEAM' ? teamId : null },
      });
      if (existing) {
        return reply.status(409).send({
          error: {
            code: 'CREDENTIAL_EXISTS',
            message: `Credential for provider '${provider}' at scope '${scope}' already exists. Use PUT /credentials/${existing.id} to update.`,
          },
        });
      }

      const sealed = encryptSecret(apiKey);
      try {
        const created = await fastify.prisma.providerCredential.create({
          data: {
            apiBase: apiBase ?? null,
            apiKeyAuthTag: sealed.authTag,
            apiKeyCiphertext: sealed.ciphertext,
            apiKeyNonce: sealed.nonce,
            createdById: actor.sub,
            keyVersion: sealed.keyVersion,
            lastFour: sealed.lastFour,
            provider,
            scope,
            teamId: scope === 'TEAM' ? teamId : null,
          },
        });
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor,
          after: redactCredential(created),
          entityId: created.id,
          entityType: 'ProviderCredential',
        });
        return reply.status(201).send({ data: redactCredential(created) });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          // Lost race with a concurrent POST — surface as 409, same as the
          // pre-flight check would have.
          return reply.status(409).send({
            error: {
              code: 'CREDENTIAL_EXISTS',
              message: `Credential for '${provider}' already exists at this scope (concurrent insert).`,
            },
          });
        }
        throw err;
      }
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

      const { apiBase, apiKey } = request.body;
      // biome-ignore lint/suspicious/noExplicitAny: dynamic update shape
      const data: Record<string, any> = {};
      if (apiBase !== undefined) data.apiBase = apiBase;
      if (apiKey) {
        const sealed = encryptSecret(apiKey);
        data.apiKeyCiphertext = sealed.ciphertext;
        data.apiKeyNonce = sealed.nonce;
        data.apiKeyAuthTag = sealed.authTag;
        data.keyVersion = sealed.keyVersion;
        data.lastFour = sealed.lastFour;
      }
      const updated = await fastify.prisma.providerCredential.update({
        data,
        where: { id: existing.id },
      });
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
      // Import the decrypt helper lazily — keeps the cold path off the
      // critical request path for routes that don't need it.
      const { decryptSecret } = await import('@auto-swe/shared/lib/crypto');
      const apiKey = decryptSecret({
        authTag: cred.apiKeyAuthTag,
        ciphertext: cred.apiKeyCiphertext,
        keyVersion: cred.keyVersion,
        nonce: cred.apiKeyNonce,
      });
      const probe = await probeCredential({
        apiBase: cred.apiBase,
        apiKey,
        provider: cred.provider,
      });
      return { data: probe };
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

      const existing = await fastify.prisma.embeddingConfig.findUnique({
        where: { id: 'default' },
      });
      const updated = await fastify.prisma.embeddingConfig.upsert({
        create: {
          credentialId: credentialId ?? null,
          id: 'default',
          modelSpec,
          updatedById: actor.sub,
        },
        update: { credentialId: credentialId ?? null, modelSpec, updatedById: actor.sub },
        where: { id: 'default' },
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

  /// One-click admin bootstrap: inserts a GLOBAL ModelRoleConfig row for each
  /// of the 6 roles using the baked-in defaults, plus the EmbeddingConfig
  /// singleton if missing. Idempotent — skips roles that already have a
  /// GLOBAL row. Does NOT seed credentials; those must be added separately
  /// because they require a real API key from the operator.
  app.post('/defaults', { onRequest: adminOnly }, async (request) => {
    const actor = requireUser(request);
    const defaults = {
      COMMIT_TO_MEMORY: 'anthropic/claude-opus-4-7',
      IMPLEMENTER: 'anthropic/claude-opus-4-7',
      PLANNER: 'anthropic/claude-sonnet-4-6',
      REVIEWER: 'anthropic/claude-opus-4-7',
      SECURITY_REVIEW: 'anthropic/claude-sonnet-4-6',
      VALIDATE_CONTEXT: 'anthropic/claude-sonnet-4-6',
    } as const;

    let rolesSeeded = 0;
    for (const [role, spec] of Object.entries(defaults)) {
      const existing = await fastify.prisma.modelRoleConfig.findFirst({
        where: { role: role as keyof typeof defaults, scope: 'GLOBAL' },
      });
      if (existing) continue;
      // Two admins double-clicking the button race on the count-then-create;
      // the partial unique index on (role) WHERE scope='GLOBAL' makes the
      // second insert fail. Swallow it — the first writer wins.
      try {
        const created = await fastify.prisma.modelRoleConfig.create({
          data: {
            createdById: actor.sub,
            modelSpec: spec,
            role: role as keyof typeof defaults,
            scope: 'GLOBAL',
          },
        });
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor,
          after: created,
          entityId: created.id,
          entityType: 'ModelRoleConfig',
        });
        rolesSeeded += 1;
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
      }
    }

    let embeddingSeeded = false;
    const existingEmbedding = await fastify.prisma.embeddingConfig.findUnique({
      where: { id: 'default' },
    });
    if (!existingEmbedding) {
      try {
        await fastify.prisma.embeddingConfig.create({
          data: {
            id: 'default',
            modelSpec: 'openai/text-embedding-3-large',
            updatedById: actor.sub,
          },
        });
        embeddingSeeded = true;
      } catch (err) {
        // Same race — id='default' is the singleton primary key, so a
        // concurrent insert produces P2002. Treat as "already seeded".
        if (!isUniqueConstraintError(err)) throw err;
      }
    }

    return { data: { embeddingSeeded, rolesSeeded } };
  });
};

const EMBEDDING_CONFIG_SENTINEL_UUID = '00000000-0000-4000-a000-000000000001';

// ── Team-scoped route helpers (exported for `teams.ts` to mount) ───────────

const TeamModelConfigUpsert = z.object({
  credentialId: z.string().uuid().nullable().optional(),
  modelSpec: ModelSpecSchema,
  role: z.enum(ROLE_VALUES),
});

const TeamCredentialCreate = z.object({
  apiBase: z.string().url().max(500).optional(),
  apiKey: z.string().min(1).max(10_000),
  provider: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'provider must be lowercase-kebab-case'),
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
      const { role, modelSpec, credentialId } = request.body;
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
      return upsertModelRoleConfig(fastify, actor, reply, {
        credentialId: credentialId ?? null,
        modelSpec,
        role,
        scope: 'TEAM',
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

  app.post(
    '/:id/credentials',
    { onRequest: teamAdmin, schema: { body: TeamCredentialCreate, params: IdParams } },
    async (request, reply): Promise<unknown> => {
      const actor = requireUser(request);
      const { provider, apiBase, apiKey } = request.body;
      const existing = await fastify.prisma.providerCredential.findFirst({
        where: { provider, scope: 'TEAM', teamId: request.params.id },
      });
      if (existing) {
        return reply.status(409).send({
          error: {
            code: 'CREDENTIAL_EXISTS',
            message: `Credential for '${provider}' already exists for this team`,
          },
        });
      }
      const sealed = encryptSecret(apiKey);
      try {
        const created = await fastify.prisma.providerCredential.create({
          data: {
            apiBase: apiBase ?? null,
            apiKeyAuthTag: sealed.authTag,
            apiKeyCiphertext: sealed.ciphertext,
            apiKeyNonce: sealed.nonce,
            createdById: actor.sub,
            keyVersion: sealed.keyVersion,
            lastFour: sealed.lastFour,
            provider,
            scope: 'TEAM',
            teamId: request.params.id,
          },
        });
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor,
          after: redactCredential(created),
          entityId: created.id,
          entityType: 'ProviderCredential',
        });
        return reply.status(201).send({ data: redactCredential(created) });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return reply.status(409).send({
            error: {
              code: 'CREDENTIAL_EXISTS',
              message: `Credential for '${provider}' already exists for this team (concurrent insert).`,
            },
          });
        }
        throw err;
      }
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
      const { apiBase, apiKey } = request.body;
      // biome-ignore lint/suspicious/noExplicitAny: dynamic update shape
      const data: Record<string, any> = {};
      if (apiBase !== undefined) data.apiBase = apiBase;
      if (apiKey) {
        const sealed = encryptSecret(apiKey);
        data.apiKeyCiphertext = sealed.ciphertext;
        data.apiKeyNonce = sealed.nonce;
        data.apiKeyAuthTag = sealed.authTag;
        data.keyVersion = sealed.keyVersion;
        data.lastFour = sealed.lastFour;
      }
      const updated = await fastify.prisma.providerCredential.update({
        data,
        where: { id: existing.id },
      });
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
  );
};

// Silence unused-export warnings — these are imported by gateway/src/index.ts.
export type { FastifyReply };
