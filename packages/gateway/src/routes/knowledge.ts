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
import { isPlatformAdmin, userActor } from '@auto-swe/shared/permissions';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { can } from '../lib/authz.js';
import { sendError } from '../lib/httpErrors.js';
import { assertTeamParam } from '../lib/teamParam.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100).default(0),
  q: z.string().trim().min(1).max(160).optional(),
  status: z.enum(['UNREVIEWED', 'APPROVED', 'REJECTED', 'SUPERSEDED']).optional(),
  teamId: z.string().uuid().optional(),
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
    { onRequest: requireAuth(), schema: { querystring: ListQuery } },
    async (request, reply) => {
      const user = requireUser(request);
      const capability = await capabilityFor(user, request);
      const { limit, offset, q, status, teamId, type, view } = request.query;
      // A member's team, or any for a platform ADMIN; it only narrows what the caller may read.
      if (teamId) {
        await assertTeamParam(fastify.prisma, user, teamId);
      }
      if (view === 'read') {
        const safe = await listReadableKnowledge(fastify.prisma, user.sub, capability, 100, {
          ...(teamId ? { teamId } : {}),
        });
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
          teamId,
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
      onRequest: requireAuth(),
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
      onRequest: requireAuth(),
      schema: { querystring: PermissionQuery },
    },
    async (request) => {
      const user = requireUser(request);
      // Each flag is the capability the matching action asks: asked of a named team or
      // organization, or of neither (then only a platform admin holds it).
      const teamResource = request.query.teamId ? { teamId: request.query.teamId } : undefined;
      const orgResource = request.query.orgId ? { orgId: request.query.orgId } : undefined;
      const [manage, approve, publish] = await Promise.all([
        can(request, 'team.knowledge.manage', teamResource),
        can(request, 'team.knowledge.approve', teamResource),
        can(request, 'org.knowledge.publish', orgResource),
      ]);
      return {
        data: {
          canCreateCurated: manage.allowed,
          canManageTeam: manage.allowed,
          canPublishOrganization: publish.allowed,
          canPublishSelectedTeams: approve.allowed,
          platformAdmin: isPlatformAdmin(userActor(user)),
          repoOriginActionsRequireSourceAccess: true,
        },
      };
    }
  );

  app.get(
    '/:id',
    { onRequest: requireAuth(), schema: { params: IdParams } },
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
      onRequest: requireAuth(),
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
      onRequest: requireAuth(),
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
      onRequest: requireAuth(),
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
      onRequest: requireAuth(),
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
      onRequest: requireAuth(),
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
      onRequest: requireAuth(),
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
