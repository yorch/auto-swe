import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
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
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { querystring: ListBaselinesQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const rows = await fastify.prisma.humanErrorBaseline.findMany({
        orderBy: { recordedAt: 'desc' },
        where: {
          organization: { memberships: { some: { userId: user.sub } } },
          orgId: request.query.orgId,
        },
      });
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
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { body: CreateBaselineBody },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { errorCount, orgId, sampleSize } = request.body;
      if (errorCount > sampleSize) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_BASELINE',
            message: 'errorCount cannot exceed sampleSize',
          },
        });
      }

      const membership = await fastify.prisma.organizationMembership.findFirst({
        where: { orgId, userId: user.sub },
      });
      if (!membership && user.role !== 'ADMIN') {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'You are not a member of this organization' },
        });
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
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { params: BaselineIdParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await fastify.prisma.humanErrorBaseline.findFirst({
        where: {
          id: request.params.id,
          organization: { memberships: { some: { userId: user.sub } } },
        },
      });
      if (!existing) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Baseline not found' },
        });
      }
      await fastify.prisma.humanErrorBaseline.delete({
        where: { id: request.params.id },
      });
      return reply.status(204).send();
    }
  );
};
