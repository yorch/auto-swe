import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { builtinModelFor, findUnpricedSpecs } from '../lib/modelCatalogService.js';
import { discoverProviderModels } from '../lib/modelDiscovery.js';
import { booleanQueryParam } from '../lib/queryParams.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/**
 * The model catalog: one row per `<provider>/<model-id>` spec with the per-MTok
 * USD prices the worker costs LLM calls at. Any signed-in user may read it — a
 * team's agent editor needs it to pick a model — but writes are ADMIN-only: a
 * price decides what USD budgets see.
 *
 * Built-in rows are seeded from `BUILTIN_MODELS` at gateway startup and kept in
 * step with code until an admin edits one, which marks it customized. A
 * built-in row cannot be deleted (startup would re-create it) — retire it.
 */

const Price = z.number().finite().min(0).max(100_000);
const KindSchema = z.enum(['CHAT', 'EMBEDDING']);
const StatusSchema = z.enum(['ACTIVE', 'DEPRECATED', 'RETIRED']);

const CatalogFields = {
  displayName: z.string().trim().min(1).max(200).nullable().optional(),
  inputUsdPerMTok: Price,
  kind: KindSchema.optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  outputUsdPerMTok: Price,
  status: StatusSchema.optional(),
};

const CreateBody = z.object({
  ...CatalogFields,
  modelId: z.string().min(1).max(200).regex(/^\S+$/, 'modelId must not contain whitespace'),
  provider: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'provider must be lowercase-kebab-case'),
});

// Provider and modelId are the row's identity, and pinned agent versions bill
// against it, so an edit never changes them — delete and re-create instead.
const UpdateBody = z.object({
  ...CatalogFields,
  inputUsdPerMTok: Price.optional(),
  outputUsdPerMTok: Price.optional(),
});

const ListQuery = z.object({
  includeRetired: booleanQueryParam(false),
  kind: KindSchema.optional(),
});

const IdParams = z.object({ id: z.string().uuid() });

type CatalogRow = {
  id: string;
  provider: string;
  modelId: string;
  isBuiltIn: boolean;
  [field: string]: unknown;
};

/** A row plus, for a built-in, the values code ships — so a customized row can show what it diverges from. */
function toDto(row: CatalogRow) {
  const builtin = row.isBuiltIn ? builtinModelFor(`${row.provider}/${row.modelId}`) : undefined;
  return {
    ...row,
    builtin: builtin
      ? {
          inputUsdPerMTok: builtin.inputUsdPerMTok,
          kind: builtin.kind,
          outputUsdPerMTok: builtin.outputUsdPerMTok,
          status: builtin.status,
        }
      : null,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

export const modelCatalogRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const anyUser = requireAuth();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  app.get(
    '/model-catalog',
    { onRequest: anyUser, schema: { querystring: ListQuery } },
    async (request) => {
      const { includeRetired, kind } = request.query;
      const rows = await fastify.prisma.modelCatalogEntry.findMany({
        orderBy: [{ provider: 'asc' }, { modelId: 'asc' }],
        where: {
          ...(kind && { kind }),
          ...(!includeRetired && { status: { not: 'RETIRED' } }),
        },
      });
      return { data: rows.map(toDto) };
    }
  );

  app.get('/model-catalog/unpriced', { onRequest: adminOnly }, async () => ({
    data: await findUnpricedSpecs(fastify.prisma),
  }));

  // POST, not GET: it calls every provider with a decrypted key, so it must not
  // be cacheable or triggered by following a link. It writes nothing.
  app.post('/model-catalog/discover', { onRequest: adminOnly }, async () => ({
    data: await discoverProviderModels(fastify.prisma),
  }));

  app.post(
    '/model-catalog',
    { onRequest: adminOnly, schema: { body: CreateBody } },
    async (request, reply) => {
      const actor = requireUser(request);
      let row: CatalogRow;
      try {
        row = await fastify.prisma.modelCatalogEntry.create({
          data: { ...request.body, isBuiltIn: false, isCustomized: false },
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply.status(409).send({
            error: {
              code: 'MODEL_EXISTS',
              message: `'${request.body.provider}/${request.body.modelId}' is already in the catalog`,
            },
          });
        }
        throw err;
      }
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor,
        after: row,
        entityId: row.id,
        entityType: 'ModelCatalogEntry',
      });
      return reply.status(201).send({ data: toDto(row) });
    }
  );

  app.put(
    '/model-catalog/:id',
    { onRequest: adminOnly, schema: { body: UpdateBody, params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.modelCatalogEntry.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Model catalog entry not found' } });
      }
      // Any edit to a built-in marks it customized, so startup seeding keeps it.
      const updated = await fastify.prisma.modelCatalogEntry.update({
        data: { ...request.body, ...(existing.isBuiltIn && { isCustomized: true }) },
        where: { id: existing.id },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: updated,
        before: existing,
        entityId: existing.id,
        entityType: 'ModelCatalogEntry',
      });
      return { data: toDto(updated) };
    }
  );

  app.post(
    '/model-catalog/:id/reset',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.modelCatalogEntry.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Model catalog entry not found' } });
      }
      const builtin = existing.isBuiltIn
        ? builtinModelFor(`${existing.provider}/${existing.modelId}`)
        : undefined;
      if (!builtin) {
        return reply.status(409).send({
          error: {
            code: 'NOT_BUILT_IN',
            message: 'Only a model that ships built-in can be reset to its built-in values',
          },
        });
      }
      const updated = await fastify.prisma.modelCatalogEntry.update({
        data: {
          inputUsdPerMTok: builtin.inputUsdPerMTok,
          isCustomized: false,
          kind: builtin.kind,
          outputUsdPerMTok: builtin.outputUsdPerMTok,
          status: builtin.status,
        },
        where: { id: existing.id },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: updated,
        before: existing,
        entityId: existing.id,
        entityType: 'ModelCatalogEntry',
      });
      return { data: toDto(updated) };
    }
  );

  app.delete(
    '/model-catalog/:id',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.modelCatalogEntry.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Model catalog entry not found' } });
      }
      if (existing.isBuiltIn) {
        return reply.status(409).send({
          error: {
            code: 'BUILT_IN_MODEL',
            message:
              'A built-in model cannot be deleted — gateway startup would re-create it. Set its status to RETIRED instead.',
          },
        });
      }
      await fastify.prisma.modelCatalogEntry.delete({ where: { id: existing.id } });
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor,
        before: existing,
        entityId: existing.id,
        entityType: 'ModelCatalogEntry',
      });
      return { data: { deleted: true, id: existing.id } };
    }
  );
};
