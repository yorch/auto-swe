import {
  ApproveKnowledgeItemSchema,
  approveKnowledgeItem,
  CreateCuratedKnowledgeItemSchema,
  createCuratedKnowledgeItem,
  createUserKnowledgeRepositoryCapability,
  getManagedKnowledgeItem,
  getReadableKnowledgeItem,
  KnowledgeAccessError,
  type KnowledgeManagementProjection,
  KnowledgeVersionConflictError,
  listManagedKnowledge,
  listReadableKnowledge,
  publishApprovedKnowledgeItem,
  ReviseKnowledgeItemSchema,
  rejectKnowledgeItem,
  reviseKnowledgeItem,
  supersedeKnowledgeItem,
} from '@auto-swe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sendError } from '../lib/httpErrors.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100).default(0),
  q: z.string().trim().min(1).max(160).optional(),
  status: z.enum(['UNREVIEWED', 'APPROVED', 'REJECTED', 'SUPERSEDED']).optional(),
  type: z.enum(['LEARNING', 'REFERENCE', 'DECISION', 'POLICY']).optional(),
  view: z.enum(['read', 'review']).default('read'),
});
const IdParams = z.object({ id: z.string().uuid() });
const VersionBody = z.object({ expectedVersion: z.number().int().positive() });
const PermissionQuery = z.object({
  orgId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
});

function errorResponse(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof KnowledgeVersionConflictError) {
    return sendError(reply, 409, 'VERSION_CONFLICT', error.message);
  }
  if (error instanceof KnowledgeAccessError) {
    return sendError(reply, 403, 'FORBIDDEN', 'Knowledge access denied');
  }
  throw error;
}

export const knowledgeRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const capabilityFor = (user: ReturnType<typeof requireUser>, request: FastifyRequest) =>
    createUserKnowledgeRepositoryCapability(fastify.prisma, user.sub, async (repoId, actor) => {
      // Use the fresh DB role resolved with the candidate scope, never the cached token role.
      if (actor.kind === 'user' && actor.isPlatformAdmin) {
        return true;
      }
      if (actor.kind !== 'user') {
        return false;
      }
      return Boolean(
        await fastify.prisma.connection.findFirst({
          select: { id: true },
          where: { AND: [{ id: repoId }, reachableConnections(user, request.repoAccessGate)] },
        })
      );
    });

  app.get(
    '/',
    { onRequest: requireAuth({ requiredRole: 'ENGINEER' }), schema: { querystring: ListQuery } },
    async (request, reply) => {
      const user = requireUser(request);
      const capability = await capabilityFor(user, request);
      const { limit, offset, q, status, type, view } = request.query;
      if (view === 'read') {
        const safe = await listReadableKnowledge(fastify.prisma, user.sub, capability, 100);
        const filtered = safe.filter(
          (item) =>
            (!status || item.status === status) &&
            (!type || item.type === type) &&
            (!q ||
              `${item.title}\n${item.content}`.toLocaleLowerCase().includes(q.toLocaleLowerCase()))
        );
        const data = filtered.slice(offset, offset + limit);
        return {
          data,
          meta: { limit, offset, returned: data.length, searchMode: q ? 'text' : undefined },
        };
      }
      try {
        const managed = await listManagedKnowledge(fastify.prisma, user.sub, capability, {
          limit: Math.min(100, limit + offset),
          query: q,
          status,
          type,
        });
        const data = managed.slice(offset, offset + limit);
        return {
          data,
          meta: { limit, offset, returned: data.length, searchMode: q ? 'text' : undefined },
        };
      } catch (error) {
        return errorResponse(error, reply);
      }
    }
  );

  app.get(
    '/search',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).default(10),
          q: z.string().trim().min(1).max(160),
        }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const capability = await capabilityFor(user, request);
      const q = request.query.q.toLocaleLowerCase();
      const candidates = await listReadableKnowledge(fastify.prisma, user.sub, capability, 100);
      const data = candidates
        .filter((item) => `${item.title}\n${item.content}`.toLocaleLowerCase().includes(q))
        .slice(0, request.query.limit);
      return { data, meta: { limit: request.query.limit, searchMode: 'text' } };
    }
  );

  app.get(
    '/permissions',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: PermissionQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const [{ role }, team, organization] = await Promise.all([
        fastify.prisma.user.findUniqueOrThrow({ select: { role: true }, where: { id: user.sub } }),
        request.query.teamId
          ? fastify.prisma.teamMembership.findFirst({
              select: { role: true },
              where: { teamId: request.query.teamId, userId: user.sub },
            })
          : null,
        request.query.orgId
          ? fastify.prisma.organizationMembership.findFirst({
              select: { role: true },
              where: { orgId: request.query.orgId, userId: user.sub },
            })
          : null,
      ]);
      return {
        data: {
          canCreateCurated: role === 'ADMIN' || team?.role === 'LEAD' || team?.role === 'ADMIN',
          canManageTeam: role === 'ADMIN' || team?.role === 'LEAD' || team?.role === 'ADMIN',
          canPublishOrganization: role === 'ADMIN' || organization?.role === 'ORG_ADMIN',
          canPublishSelectedTeams:
            role === 'ADMIN' || team?.role === 'LEAD' || team?.role === 'ADMIN',
          platformAdmin: role === 'ADMIN',
          repoOriginActionsRequireSourceAccess: true,
        },
      };
    }
  );

  app.get(
    '/:id',
    { onRequest: requireAuth({ requiredRole: 'ENGINEER' }), schema: { params: IdParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const capability = await capabilityFor(user, request);
      try {
        let managed: KnowledgeManagementProjection | null = null;
        try {
          managed = await getManagedKnowledgeItem(
            fastify.prisma,
            user.sub,
            request.params.id,
            capability
          );
        } catch (error) {
          if (!(error instanceof KnowledgeAccessError)) {
            throw error;
          }
        }
        if (managed) {
          return { data: managed };
        }
        const readable = await getReadableKnowledgeItem(
          fastify.prisma,
          user.sub,
          request.params.id,
          capability
        );
        if (!readable) {
          return sendError(reply, 404, 'NOT_FOUND', 'Knowledge item not found');
        }
        return { data: { ...readable, provenance: null } };
      } catch (error) {
        return errorResponse(error, reply);
      }
    }
  );

  app.post(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: CreateCuratedKnowledgeItemSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const capability = await capabilityFor(user, request);
      try {
        const data = await createCuratedKnowledgeItem(
          fastify.prisma,
          user.sub,
          request.body,
          capability
        );
        return reply.status(201).send({ data });
      } catch (error) {
        return errorResponse(error, reply);
      }
    }
  );

  app.put(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: ReviseKnowledgeItemSchema, params: IdParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const capability = await capabilityFor(user, request);
      try {
        return {
          data: await reviseKnowledgeItem(
            fastify.prisma,
            user.sub,
            request.params.id,
            request.body,
            capability
          ),
        };
      } catch (error) {
        return errorResponse(error, reply);
      }
    }
  );

  app.post(
    '/:id/approve',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: ApproveKnowledgeItemSchema, params: IdParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const capability = await capabilityFor(user, request);
      try {
        return {
          data: await approveKnowledgeItem(
            fastify.prisma,
            user.sub,
            request.params.id,
            request.body,
            capability
          ),
        };
      } catch (error) {
        return errorResponse(error, reply);
      }
    }
  );
  app.post(
    '/:id/publish',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: ApproveKnowledgeItemSchema, params: IdParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const capability = await capabilityFor(user, request);
      try {
        return {
          data: await publishApprovedKnowledgeItem(
            fastify.prisma,
            user.sub,
            request.params.id,
            request.body,
            capability
          ),
        };
      } catch (error) {
        return errorResponse(error, reply);
      }
    }
  );
  app.post(
    '/:id/reject',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: VersionBody, params: IdParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const capability = await capabilityFor(user, request);
      try {
        return {
          data: await rejectKnowledgeItem(
            fastify.prisma,
            user.sub,
            request.params.id,
            request.body.expectedVersion,
            capability
          ),
        };
      } catch (error) {
        return errorResponse(error, reply);
      }
    }
  );
  app.post(
    '/:id/supersede',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: VersionBody, params: IdParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const capability = await capabilityFor(user, request);
      try {
        return {
          data: await supersedeKnowledgeItem(
            fastify.prisma,
            user.sub,
            request.params.id,
            request.body.expectedVersion,
            capability
          ),
        };
      } catch (error) {
        return errorResponse(error, reply);
      }
    }
  );
};
