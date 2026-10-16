import { cacheMultipliers } from '@auto-swe/shared/lib/builtinModels';
import { knownModels } from '@auto-swe/shared/lib/modelDiscovery';
import { runModelDiscovery } from '@auto-swe/shared/lib/modelSuggestions';
import { DEFAULT_ROLE_PRICING } from '@auto-swe/shared/workflow/costEstimator';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { builtinModelFor, findUnpricedSpecs, rolePricing } from '../lib/modelCatalogService.js';
import { findPriceHints } from '../lib/modelPriceHints.js';
import { isRecordNotFoundError, isUniqueConstraintError } from '../lib/prismaErrors.js';
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
/** A cache rate as a multiple of the input price; null clears the override. */
const Multiplier = z.number().finite().min(0).max(20).nullable().optional();
const KindSchema = z.enum(['CHAT', 'EMBEDDING']);
const StatusSchema = z.enum(['ACTIVE', 'DEPRECATED', 'RETIRED']);

const CatalogFields = {
  cacheReadMultiplier: Multiplier,
  cacheWrite1hMultiplier: Multiplier,
  cacheWrite5mMultiplier: Multiplier,
  displayName: z.string().trim().min(1).max(200).nullable().optional(),
  inputUsdPerMTok: Price,
  kind: KindSchema.optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  outputUsdPerMTok: Price,
  status: StatusSchema.optional(),
};

const SpecFields = {
  modelId: z.string().min(1).max(200).regex(/^\S+$/, 'modelId must not contain whitespace'),
  provider: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'provider must be lowercase-kebab-case'),
};

const CreateBody = z.object({ ...CatalogFields, ...SpecFields });

const PriceHintBody = z.object(SpecFields);

const specOf = (e: { provider: string; modelId: string }) => `${e.provider}/${e.modelId}`;

/** Bulk add from the discovery list: all of the models, or none of them. */
const BatchCreateBody = z.object({
  entries: z
    .array(CreateBody)
    .min(1)
    .max(100)
    .refine((es) => new Set(es.map(specOf)).size === es.length, 'each model may appear only once'),
});

/** The discovery list's page: one call prices every new model it shows. */
const PriceHintBatchBody = z.object({ specs: z.array(PriceHintBody).min(1).max(200) });

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

/** Audit entity id for a discovery run, which touches many suggestions at once. */
const DISCOVERY_AUDIT_ID = '00000000-0000-4000-a000-000000000002';

const SuggestionQuery = z.object({ includeDismissed: booleanQueryParam(false) });

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
  // What a null multiplier means: the code table's rate for this spec.
  const defaults = cacheMultipliers(`${row.provider}/${row.modelId}`);
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
    cacheDefaults: {
      cacheReadMultiplier: defaults.read,
      cacheWrite1hMultiplier: defaults.write1h,
      cacheWrite5mMultiplier: defaults.write,
    },
  };
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

  // Any signed-in user: the workflow editor shows its estimate to template
  // authors, who cannot read the agent library itself. Only model specs and
  // prices leave, not the agents' prompts or tools.
  app.get('/model-catalog/role-pricing', { onRequest: anyUser }, async () => ({
    data: await rolePricing(fastify.prisma, Object.keys(DEFAULT_ROLE_PRICING)),
  }));

  app.get('/model-catalog/unpriced', { onRequest: adminOnly }, async () => ({
    data: await findUnpricedSpecs(fastify.prisma),
  }));

  // The suggestions the last discovery run stored, and when each provider was
  // last asked. Each row is checked against the catalog again on read, so a model
  // an admin has since priced is never shown as new, and one they have since
  // retired or deleted is never shown as possibly retired, before the next run.
  app.get(
    '/model-catalog/suggestions',
    { onRequest: adminOnly, schema: { querystring: SuggestionQuery } },
    async (request) => {
      const [rows, providers, known] = await Promise.all([
        fastify.prisma.modelSuggestion.findMany({
          orderBy: [{ provider: 'asc' }, { modelId: 'asc' }],
        }),
        fastify.prisma.modelDiscoveryProviderStatus.findMany({ orderBy: { provider: 'asc' } }),
        knownModels(fastify.prisma),
      ]);
      const lastComplete = new Map(providers.map((p) => [p.provider, p.lastSuccessAt]));
      const applicable = rows
        .map((r) => ({ ...r, spec: `${r.provider}/${r.modelId}` }))
        .filter((r) => {
          const model = known.get(r.spec);
          if (!(r.type === 'NEW' ? !model : model !== undefined && !model.retired)) {
            return false;
          }
          // A dismissed row is kept so a dismissal outlives the model leaving and
          // returning, but one not seen since its provider's last complete listing
          // describes a model that listing did not show: it no longer applies.
          const complete = lastComplete.get(r.provider);
          return !(r.dismissedAt && complete && r.lastSeenAt < complete);
        });
      const hiddenDismissed = { NEW: 0, RETIREMENT_CANDIDATE: 0 };
      if (!request.query.includeDismissed) {
        for (const r of applicable) {
          if (r.dismissedAt) {
            hiddenDismissed[r.type]++;
          }
        }
      }
      return {
        data: {
          // Per kind, so the UI can tell "everything is dismissed" from "nothing found".
          hiddenDismissed,
          providers,
          suggestions: request.query.includeDismissed
            ? applicable
            : applicable.filter((r) => r.dismissedAt === null),
        },
      };
    }
  );

  for (const [action, dismissedAt] of [
    ['dismiss', () => new Date()],
    ['undismiss', () => null],
  ] as const) {
    app.post(
      `/model-catalog/suggestions/:id/${action}`,
      { onRequest: adminOnly, schema: { params: IdParams } },
      async (request, reply) => {
        try {
          const actor = requireUser(request);
          const before = await fastify.prisma.modelSuggestion.findUnique({
            where: { id: request.params.id },
          });
          const row = await fastify.prisma.modelSuggestion.update({
            data: { dismissedAt: dismissedAt() },
            where: { id: request.params.id },
          });
          await writeAuditLog(fastify, {
            action: 'UPDATE',
            actor,
            after: row,
            before,
            entityId: row.id,
            entityType: 'ModelSuggestion',
          });
          return { data: row };
        } catch (err) {
          if (isRecordNotFoundError(err)) {
            return sendError(reply, 404, 'NOT_FOUND', 'Suggestion not found');
          }
          throw err;
        }
      }
    );
  }

  // POST, not GET: it calls every provider with a decrypted key, so it must not
  // be cacheable or triggered by following a link. It writes no catalog row; it
  // does refresh the stored suggestions, exactly as the scheduled run does, so
  // the list an admin reads afterwards agrees with what this returned.
  app.post('/model-catalog/discover', { onRequest: adminOnly }, async (request) => {
    const actor = requireUser(request);
    const { results, summary } = await runModelDiscovery(fastify.prisma);
    await writeAuditLog(fastify, {
      action: 'UPDATE',
      actor,
      after: summary,
      entityId: DISCOVERY_AUDIT_ID,
      entityType: 'ModelSuggestion',
    });
    return { data: results };
  });

  // What a model is published to cost, for the Add form to prefill: the
  // provider's own listing where it states a price, then the community price
  // list. POST for the same reason as discover — it can call a provider with a
  // decrypted key. Writes nothing: an admin still saves every price.
  app.post(
    '/model-catalog/price-hints',
    { onRequest: adminOnly, schema: { body: PriceHintBody } },
    async (request) => {
      const { provider, modelId } = request.body;
      return { data: await findPriceHints(fastify.prisma, provider, modelId) };
    }
  );

  // The same hints for many specs at once. Each provider is listed once and the
  // price list fetched once, whatever the batch size: both are cached and shared.
  app.post(
    '/model-catalog/price-hints/batch',
    { onRequest: adminOnly, schema: { body: PriceHintBatchBody } },
    async (request) => ({
      data: await Promise.all(
        request.body.specs.map(async ({ provider, modelId }) => ({
          modelId,
          provider,
          ...(await findPriceHints(fastify.prisma, provider, modelId)),
        }))
      ),
    })
  );

  // Adds many models in one transaction, so a refused one leaves the catalog as it
  // was: a spec already there is a 409 naming every such spec, before anything is
  // written. Each row is audited as a single add would be.
  app.post(
    '/model-catalog/batch',
    { onRequest: adminOnly, schema: { body: BatchCreateBody } },
    async (request, reply) => {
      const actor = requireUser(request);
      const { entries } = request.body;
      const wanted = new Set(entries.map(specOf));
      const existing = (
        await fastify.prisma.modelCatalogEntry.findMany({
          select: { modelId: true, provider: true },
          where: { OR: entries.map(({ modelId, provider }) => ({ modelId, provider })) },
        })
      )
        .map(specOf)
        .filter((spec) => wanted.has(spec))
        .sort();
      const conflict = (specs: string[]) =>
        sendError(
          reply,
          409,
          'MODEL_EXISTS',
          specs.length
            ? `Already in the catalog: ${specs.join(', ')}. Nothing was added.`
            : 'A model in the batch was added meanwhile. Nothing was added.',
          { specs }
        );
      if (existing.length > 0) {
        return conflict(existing);
      }
      let rows: CatalogRow[];
      try {
        rows = await fastify.prisma.$transaction(async (tx) => {
          const created: CatalogRow[] = [];
          for (const entry of entries) {
            created.push(
              await tx.modelCatalogEntry.create({
                data: { ...entry, isBuiltIn: false, isCustomized: false },
              })
            );
          }
          return created;
        });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return conflict([]);
        }
        throw err;
      }
      for (const row of rows) {
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor,
          after: row,
          entityId: row.id,
          entityType: 'ModelCatalogEntry',
        });
      }
      return reply.status(201).send({ data: rows.map(toDto) });
    }
  );

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
        if (isUniqueConstraintError(err)) {
          return sendError(
            reply,
            409,
            'MODEL_EXISTS',
            `'${request.body.provider}/${request.body.modelId}' is already in the catalog`
          );
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
        return sendError(reply, 404, 'NOT_FOUND', 'Model catalog entry not found');
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
        return sendError(reply, 404, 'NOT_FOUND', 'Model catalog entry not found');
      }
      const builtin = existing.isBuiltIn
        ? builtinModelFor(`${existing.provider}/${existing.modelId}`)
        : undefined;
      if (!builtin) {
        return sendError(
          reply,
          409,
          'NOT_BUILT_IN',
          'Only a model that ships built-in can be reset to its built-in values'
        );
      }
      const updated = await fastify.prisma.modelCatalogEntry.update({
        data: {
          // Back to "use the code table", which is what a seeded row holds.
          cacheReadMultiplier: null,
          cacheWrite1hMultiplier: null,
          cacheWrite5mMultiplier: null,
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
        return sendError(reply, 404, 'NOT_FOUND', 'Model catalog entry not found');
      }
      if (existing.isBuiltIn) {
        return sendError(
          reply,
          409,
          'BUILT_IN_MODEL',
          'A built-in model cannot be deleted — gateway startup would re-create it. Set its status to RETIRED instead.'
        );
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
