import type { Prisma } from '@auto-swe/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import {
  attachableKnowledgeBaseWhere,
  effectiveKnowledgeBases,
  KnowledgeBaseRef,
} from '../lib/knowledgeBases.js';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { memberOrgs, memberTeams, reachableConnections } from '../lib/tenantScope.js';
import { type JwtPayload, requireAuth, requireUser } from '../plugins/auth.js';
import { canManageTeamRepos } from './repositories.js';

const Id = z.object({ id: z.string().uuid() });
const Mount = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const Fields = z.object({
  defaultRef: KnowledgeBaseRef.nullish(),
  description: z.string().max(4000),
  mountName: Mount,
  name: z.string().min(1).max(200),
  path: z
    .string()
    .max(1000)
    .refine(
      (path) =>
        path === '' ||
        (!path.startsWith('/') &&
          !path.includes('\\') &&
          path.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
          [...path].every((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127)),
      'Invalid repository subdirectory'
    ),
  status: z.enum(['OK', 'DISABLED']),
  visibility: z.enum(['TEAM', 'SHARED', 'ORG']),
});
const LinkFields = z.object({
  exclude: z.boolean(),
  mandatory: z.boolean(),
  mountName: Mount.nullish(),
  ref: KnowledgeBaseRef.nullish(),
});
const Target = z
  .object({
    repoId: z.string().uuid().optional(),
    scope: z.enum(['TEAM', 'REPO', 'TEMPLATE']),
    teamId: z.string().uuid().optional(),
    templateId: z.string().uuid().optional(),
  })
  .refine(
    (b) =>
      (b.scope === 'TEAM' && !!b.teamId && !b.repoId && !b.templateId) ||
      (b.scope === 'REPO' && !!b.repoId && !b.templateId && !b.teamId) ||
      (b.scope === 'TEMPLATE' && !!b.templateId && !b.repoId && !b.teamId),
    'Supply exactly the scope target'
  );
const CreateLink = Target.safeExtend({
  knowledgeBaseId: z.string().uuid(),
  ...LinkFields.shape,
  exclude: LinkFields.shape.exclude.default(false),
  mandatory: LinkFields.shape.mandatory.default(false),
}).refine(
  (b) => (!b.mandatory || b.scope === 'TEAM') && (!b.exclude || b.scope === 'TEMPLATE'),
  'mandatory requires TEAM; exclude requires TEMPLATE'
);

function visibleWhere(user: JwtPayload): Prisma.KnowledgeBaseWhereInput {
  return {
    organization: user.role === 'ADMIN' ? {} : memberOrgs(user),
    ...(user.role === 'ADMIN'
      ? {}
      : {
          OR: [
            { connection: { team: memberTeams(user) } },
            { visibility: 'ORG' as const },
            { shares: { some: { team: memberTeams(user) } }, visibility: 'SHARED' as const },
          ],
        }),
  };
}

export const knowledgeBaseRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = { onRequest: requireAuth({ requiredRole: 'ENGINEER' }) };
  const load = (id: string, user: JwtPayload) =>
    fastify.prisma.knowledgeBase.findFirst({
      include: {
        connection: { select: { team: { select: { id: true, name: true } }, teamId: true } },
        shares: true,
        snapshots: { orderBy: { indexedAt: 'desc' }, take: 10 },
      },
      where: { AND: [visibleWhere(user)], id },
    });

  app.get('/knowledge-bases', auth, async (request) => ({
    data: await asPlatformAdmin(
      requireUser(request),
      'platform administrators manage knowledge bases across organizations',
      ['KnowledgeBase'],
      () =>
        fastify.prisma.knowledgeBase.findMany({
          include: {
            connection: { select: { team: { select: { id: true, name: true } }, teamId: true } },
          },
          orderBy: { name: 'asc' },
          take: 500,
          where: {
            AND: [visibleWhere(requireUser(request))],
            organization: visibleWhere(requireUser(request)).organization,
          },
        })
    ),
  }));

  app.post(
    '/knowledge-bases',
    {
      ...auth,
      schema: {
        body: Fields.extend({
          connectionId: z.string().uuid(),
          description: Fields.shape.description.default(''),
          path: Fields.shape.path.default(''),
          status: Fields.shape.status.default('OK'),
          visibility: Fields.shape.visibility.default('TEAM'),
        }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { connectionId, ...fields } = request.body;
      const connection = await fastify.prisma.connection.findUnique({
        include: { team: true },
        where: { id: connectionId },
      });
      if (connection?.type !== 'git_repo') {
        return sendError(
          reply,
          400,
          'INVALID_CONNECTION',
          'A git repository connection is required'
        );
      }
      if (!(await canManageTeamRepos(fastify.prisma, user, connection.teamId))) {
        return sendError(reply, 403, 'FORBIDDEN', 'Owning team LEAD required');
      }
      try {
        const row = await fastify.prisma.knowledgeBase.create({
          data: { ...fields, connectionId, createdById: user.sub, orgId: connection.team.orgId },
        });
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor: user,
          after: row,
          entityId: row.id,
          entityType: 'KnowledgeBase',
        });
        return reply.code(201).send({ data: row });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return sendError(
            reply,
            409,
            'KNOWLEDGE_BASE_EXISTS',
            'Connection already has a knowledge base'
          );
        }
        throw err;
      }
    }
  );

  app.get('/knowledge-bases/:id', { ...auth, schema: { params: Id } }, async (request, reply) => {
    const row = await load(request.params.id, requireUser(request));
    return row ? { data: row } : sendError(reply, 404, 'NOT_FOUND', 'Knowledge base not found');
  });

  app.patch(
    '/knowledge-bases/:id',
    { ...auth, schema: { body: Fields.partial(), params: Id } },
    async (request, reply) => {
      const user = requireUser(request);
      const row = await load(request.params.id, user);
      if (!row) {
        return sendError(reply, 404, 'NOT_FOUND', 'Knowledge base not found');
      }
      if (!(await canManageTeamRepos(fastify.prisma, user, row.connection.teamId))) {
        return sendError(reply, 403, 'FORBIDDEN', 'Owning team LEAD required');
      }
      const updated = await fastify.prisma.knowledgeBase.update({
        data: request.body,
        where: { id: row.id },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: user,
        after: updated,
        before: row,
        entityId: row.id,
        entityType: 'KnowledgeBase',
      });
      return { data: updated };
    }
  );

  app.delete(
    '/knowledge-bases/:id',
    { ...auth, schema: { params: Id } },
    async (request, reply) => {
      const user = requireUser(request);
      const row = await load(request.params.id, user);
      if (!row) {
        return sendError(reply, 404, 'NOT_FOUND', 'Knowledge base not found');
      }
      if (!(await canManageTeamRepos(fastify.prisma, user, row.connection.teamId))) {
        return sendError(reply, 403, 'FORBIDDEN', 'Owning team LEAD required');
      }
      await fastify.prisma.knowledgeBase.delete({ where: { id: row.id } });
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor: user,
        before: row,
        entityId: row.id,
        entityType: 'KnowledgeBase',
      });
      return reply.code(204).send();
    }
  );

  app.put(
    '/knowledge-bases/:id/shares',
    {
      ...auth,
      schema: { body: z.object({ teamIds: z.array(z.string().uuid()).max(100) }), params: Id },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const row = await load(request.params.id, user);
      if (!row) {
        return sendError(reply, 404, 'NOT_FOUND', 'Knowledge base not found');
      }
      if (!(await canManageTeamRepos(fastify.prisma, user, row.connection.teamId))) {
        return sendError(reply, 403, 'FORBIDDEN', 'Owning team LEAD required');
      }
      const teamIds = [...new Set(request.body.teamIds)];
      const teams = await fastify.prisma.team.findMany({
        select: { id: true },
        where: { id: { in: teamIds }, orgId: row.orgId },
      });
      if (teams.length !== teamIds.length) {
        return sendError(
          reply,
          400,
          'INVALID_TEAMS',
          'Shares must stay within the knowledge base organization'
        );
      }
      await fastify.prisma.$transaction(async (tx) => {
        await tx.knowledgeBaseTeamShare.deleteMany({
          where: { knowledgeBase: { orgId: row.orgId }, knowledgeBaseId: row.id },
        });
        await tx.knowledgeBaseTeamShare.createMany({
          data: teamIds.map((teamId) => ({ knowledgeBaseId: row.id, teamId })),
        });
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: user,
          after: { teamIds },
          client: tx,
          entityId: row.id,
          entityType: 'KnowledgeBase',
        });
      });
      return { data: { teamIds } };
    }
  );

  app.post(
    '/knowledge-bases/:id/reindex',
    { ...auth, schema: { params: Id } },
    async (request, reply) => {
      const user = requireUser(request);
      const row = await load(request.params.id, user);
      if (!row) {
        return sendError(reply, 404, 'NOT_FOUND', 'Knowledge base not found');
      }
      if (!(await canManageTeamRepos(fastify.prisma, user, row.connection.teamId))) {
        return sendError(reply, 403, 'FORBIDDEN', 'Owning team LEAD required');
      }
      await fastify.temporal.startKnowledgeBaseIndex(row.id);
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: user,
        after: { reindex: true },
        entityId: row.id,
        entityType: 'KnowledgeBase',
      });
      return reply.code(202).send({ data: { triggered: true } });
    }
  );

  async function targetFor(body: z.infer<typeof Target>, user: JwtPayload) {
    let teamId: string | null = null;
    if (body.scope === 'TEAM') {
      teamId = body.teamId ?? null;
    }
    if (body.scope === 'REPO') {
      const repo = await fastify.prisma.connection.findUnique({ where: { id: body.repoId } });
      if (repo?.type !== 'git_repo') {
        return null;
      }
      teamId = repo.teamId;
    }
    if (body.scope === 'TEMPLATE') {
      const template = await fastify.prisma.workflowTemplate.findUnique({
        where: { id: body.templateId },
      });
      if (!template) {
        return null;
      }
      teamId = template.teamId;
      if (!teamId) {
        return user.role === 'ADMIN' ? { orgId: null, teamId: null } : null;
      }
    }
    if (!teamId || !(await canManageTeamRepos(fastify.prisma, user, teamId))) {
      return null;
    }
    const team = await fastify.prisma.team.findUnique({ where: { id: teamId } });
    return team ? { orgId: team.orgId, teamId } : null;
  }

  async function validateLinkKnowledgeBase(
    target: { orgId: string | null; teamId: string | null },
    knowledgeBaseId: string,
    exclude: boolean,
    reply: FastifyReply
  ): Promise<boolean> {
    const kb = await fastify.prisma.knowledgeBase.findFirst({
      where: {
        id: knowledgeBaseId,
        ...(target.orgId ? { orgId: target.orgId } : {}),
        ...(!exclude
          ? target.teamId && target.orgId
            ? attachableKnowledgeBaseWhere(target.teamId, target.orgId)
            : { status: 'OK', visibility: 'ORG' }
          : {}),
      },
    });
    if (!kb) {
      sendError(
        reply,
        400,
        'KNOWLEDGE_BASE_UNAVAILABLE',
        'Knowledge base is not attachable by target team'
      );
      return false;
    }
    if (
      exclude &&
      target.teamId &&
      (await fastify.prisma.knowledgeBaseLink.findFirst({
        where: { knowledgeBaseId, mandatory: true, scope: 'TEAM', teamId: target.teamId },
      }))
    ) {
      sendError(
        reply,
        400,
        'KNOWLEDGE_BASE_MANDATORY',
        'Mandatory knowledge bases cannot be excluded'
      );
      return false;
    }
    return true;
  }

  app.get(
    '/knowledge-base-links',
    { ...auth, schema: { querystring: Target } },
    async (request, reply) => {
      const target = await targetFor(request.query, requireUser(request));
      if (!target) {
        return sendError(reply, 403, 'FORBIDDEN', 'Target LEAD required');
      }
      return {
        data: await fastify.prisma.knowledgeBaseLink.findMany({
          orderBy: { id: 'asc' },
          where: {
            scope: request.query.scope,
            teamId: target.teamId,
            ...(request.query.repoId ? { repoId: request.query.repoId } : {}),
            ...(request.query.templateId ? { templateId: request.query.templateId } : {}),
          },
        }),
      };
    }
  );

  app.post(
    '/knowledge-base-links',
    { ...auth, schema: { body: CreateLink } },
    async (request, reply) => {
      const user = requireUser(request);
      const target = await targetFor(request.body, user);
      if (!target) {
        return sendError(reply, 403, 'FORBIDDEN', 'Target LEAD required');
      }
      if (
        !(await validateLinkKnowledgeBase(
          target,
          request.body.knowledgeBaseId,
          request.body.exclude,
          reply
        ))
      ) {
        return;
      }
      try {
        const row = await fastify.prisma.knowledgeBaseLink.create({
          data: { ...request.body, createdById: user.sub, teamId: target.teamId },
        });
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor: user,
          after: row,
          entityId: row.id,
          entityType: 'KnowledgeBaseLink',
        });
        return reply.code(201).send({ data: row });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return sendError(reply, 409, 'LINK_EXISTS', 'Knowledge base is already linked to target');
        }
        throw err;
      }
    }
  );

  app.patch(
    '/knowledge-base-links/:id',
    { ...auth, schema: { body: LinkFields.partial(), params: Id } },
    async (request, reply) => {
      const user = requireUser(request);
      const row = await fastify.prisma.knowledgeBaseLink.findUnique({
        where: { id: request.params.id },
      });
      if (!row) {
        return sendError(reply, 404, 'NOT_FOUND', 'Link not found');
      }
      const target = await targetFor(
        {
          repoId: row.repoId ?? undefined,
          scope: row.scope,
          teamId: row.teamId ?? undefined,
          templateId: row.templateId ?? undefined,
        },
        user
      );
      if (!target) {
        return sendError(reply, 403, 'FORBIDDEN', 'Target LEAD required');
      }
      if (
        (request.body.mandatory && row.scope !== 'TEAM') ||
        (request.body.exclude && row.scope !== 'TEMPLATE')
      ) {
        return sendError(
          reply,
          400,
          'INVALID_SCOPE',
          'mandatory requires TEAM; exclude requires TEMPLATE'
        );
      }
      if (
        !(await validateLinkKnowledgeBase(
          target,
          row.knowledgeBaseId,
          request.body.exclude ?? row.exclude,
          reply
        ))
      ) {
        return;
      }
      const updated = await fastify.prisma.knowledgeBaseLink.update({
        data: request.body,
        where: { id: row.id },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: user,
        after: updated,
        before: row,
        entityId: row.id,
        entityType: 'KnowledgeBaseLink',
      });
      return { data: updated };
    }
  );

  app.delete(
    '/knowledge-base-links/:id',
    { ...auth, schema: { params: Id } },
    async (request, reply) => {
      const user = requireUser(request);
      const row = await fastify.prisma.knowledgeBaseLink.findUnique({
        where: { id: request.params.id },
      });
      if (!row) {
        return sendError(reply, 404, 'NOT_FOUND', 'Link not found');
      }
      if (
        !(await targetFor(
          {
            repoId: row.repoId ?? undefined,
            scope: row.scope,
            teamId: row.teamId ?? undefined,
            templateId: row.templateId ?? undefined,
          },
          user
        ))
      ) {
        return sendError(reply, 403, 'FORBIDDEN', 'Target LEAD required');
      }
      await fastify.prisma.knowledgeBaseLink.delete({ where: { id: row.id } });
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor: user,
        before: row,
        entityId: row.id,
        entityType: 'KnowledgeBaseLink',
      });
      return reply.code(204).send();
    }
  );

  app.get(
    '/teams/:id/knowledge-bases/effective',
    {
      ...auth,
      schema: { params: Id, querystring: z.object({ templateId: z.string().uuid().optional() }) },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const team = await asPlatformAdmin(
        user,
        'administrators preview team knowledge bases',
        ['Team'],
        () =>
          fastify.prisma.team.findFirst({
            where: {
              id: request.params.id,
              isActive: true,
              ...(user.role === 'ADMIN' ? {} : memberTeams(user)),
            },
          })
      );
      if (!team) {
        return sendError(reply, 404, 'NOT_FOUND', 'Team not found');
      }
      if (request.query.templateId) {
        const template = await fastify.prisma.workflowTemplate.findFirst({
          where: { id: request.query.templateId, OR: [{ teamId: null }, { teamId: team.id }] },
        });
        if (!template) {
          return sendError(reply, 404, 'NOT_FOUND', 'Template not found');
        }
      }
      return {
        data: await effectiveKnowledgeBases(fastify.prisma, {
          orgId: team.orgId,
          teamId: team.id,
          templateId: request.query.templateId,
        }),
      };
    }
  );

  app.get(
    '/repositories/:id/knowledge-bases/effective',
    {
      ...auth,
      schema: { params: Id, querystring: z.object({ templateId: z.string().uuid().optional() }) },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const repo = await fastify.prisma.connection.findFirst({
        include: { team: true },
        where: { AND: [reachableConnections(user, request.repoAccessGate)], id: request.params.id },
      });
      if (!repo) {
        return sendError(reply, 404, 'NOT_FOUND', 'Repository not found');
      }
      if (request.query.templateId) {
        const template = await fastify.prisma.workflowTemplate.findFirst({
          where: { id: request.query.templateId, OR: [{ teamId: null }, { teamId: repo.teamId }] },
        });
        if (!template) {
          return sendError(reply, 404, 'NOT_FOUND', 'Template not found');
        }
      }
      return {
        data: await effectiveKnowledgeBases(fastify.prisma, {
          orgId: repo.team.orgId,
          repoId: repo.id,
          teamId: repo.teamId,
          templateId: request.query.templateId,
        }),
      };
    }
  );
};
