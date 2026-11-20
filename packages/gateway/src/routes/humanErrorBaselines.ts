import { isPlatformAdmin } from '@auto-swe/shared/permissions';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { can, heldScope, replyRefusal } from '../lib/authz.js';
import { sendError } from '../lib/httpErrors.js';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import { memberOrgs } from '../lib/tenantScope.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const CreateBaselineBody = z.object({
  domain: z.string().min(1).max(120),
  errorCount: z.number().int().min(0),
  orgId: z.string().uuid(),
  outcomeType: z.string().max(120).nullable().optional(),
  sampleSize: z.number().int().min(1),
});

const ListBaselinesQuery = z.object({
  orgId: z.string().uuid().optional(),
});

const BaselineIdParam = z.object({
  id: z.string().uuid(),
});

export const humanErrorBaselineRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/',
    {
      onRequest: requireAuth({ handlerChecked: ['org.baselines.read'] }),
      schema: { querystring: ListBaselinesQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const { orgId } = request.query;
      // No `orgId: undefined` key: Prisma drops it, so it filters nothing, and
      // the tenant guard rightly refuses to count it as scoping. An ADMIN
      // listing every org's baselines is a deliberate cross-tenant read, said
      // so through `asPlatformAdmin`; everyone else stays behind membership.
      const orgFilter = orgId ? { orgId } : {};
      // Any member of an organization reads its baselines (`org.baselines.read`); the operator all.
      const held = await heldScope(request, 'org.baselines.read');
      const rows = await asPlatformAdmin(
        user,
        "admin lists every organization's error baselines",
        ['HumanErrorBaseline'],
        () =>
          fastify.prisma.humanErrorBaseline.findMany({
            orderBy: { recordedAt: 'desc' },
            select: {
              domain: true,
              errorCount: true,
              errorRate: true,
              id: true,
              outcomeType: true,
              recordedAt: true,
              sampleSize: true,
            },
            where: held.all ? orgFilter : { organization: memberOrgs(user), ...orgFilter },
          })
      );
      return {
        data: rows.map((b) => ({
          domain: b.domain,
          errorCount: b.errorCount,
          errorRate: b.errorRate,
          id: b.id,
          outcomeType: b.outcomeType,
          recordedAt: b.recordedAt,
          sampleSize: b.sampleSize,
        })),
      };
    }
  );

  app.post(
    '/',
    {
      onRequest: requireAuth({ handlerChecked: ['org.baselines.manage'] }),
      schema: { body: CreateBaselineBody },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { errorCount, orgId, sampleSize } = request.body;
      if (errorCount > sampleSize) {
        return sendError(reply, 400, 'INVALID_BASELINE', 'errorCount cannot exceed sampleSize');
      }

      const decision = await can(request, 'org.baselines.manage', { orgId });
      if (!decision.allowed) {
        return replyRefusal(reply, decision);
      }

      const created = await fastify.prisma.humanErrorBaseline.create({
        data: {
          domain: request.body.domain,
          errorCount,
          errorRate: sampleSize > 0 ? errorCount / sampleSize : 0,
          orgId,
          outcomeType: request.body.outcomeType ?? null,
          recordedById: user.sub,
          sampleSize,
        },
      });
      return reply.status(201).send({
        data: {
          domain: created.domain,
          errorCount: created.errorCount,
          errorRate: created.errorRate,
          id: created.id,
          outcomeType: created.outcomeType,
          recordedAt: created.recordedAt,
          sampleSize: created.sampleSize,
        },
      });
    }
  );

  app.delete(
    '/:id',
    {
      onRequest: requireAuth({ handlerChecked: ['org.baselines.manage'] }),
      schema: { params: BaselineIdParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await fastify.prisma.humanErrorBaseline.findFirst({
        select: { id: true, orgId: true },
        where: isPlatformAdmin(user)
          ? { id: request.params.id }
          : {
              id: request.params.id,
              organization: memberOrgs(user),
            },
      });
      if (!existing) {
        return sendError(reply, 404, 'NOT_FOUND', 'Baseline not found');
      }
      // A member who can see the baseline but does not administer its organization may not remove it.
      const decision = await can(request, 'org.baselines.manage', { orgId: existing.orgId });
      if (!decision.allowed) {
        return replyRefusal(reply, decision);
      }
      await fastify.prisma.humanErrorBaseline.delete({
        where: { id: request.params.id },
      });
      return reply.status(204).send();
    }
  );
};
