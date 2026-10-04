import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type AgentScope, updateAgent } from '../lib/agentLibraryService.js';
import { writeAuditLog } from '../lib/auditLog.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Version history of one Agent lineage (a key at a scope), and restoring an old version.
 *
 *   GET  /api/v1/platform/agent-library/:id/versions   every version, newest first
 *   POST /api/v1/platform/agent-library/:id/restore    cut a NEW version from an old one
 *
 * `:id` is any version of the lineage. A restore never rewrites history: it copies the chosen
 * version's content into a new highest version, so runs pinned to any earlier version keep
 * resolving it.
 */

const IdParams = z.object({ id: z.string().uuid() });
const RestoreBody = z.object({ versionId: z.string().uuid() });

const WITH_SKILLS = {
  skillRefs: {
    include: { skill: { select: { id: true, name: true } } },
    orderBy: { sortOrder: 'asc' as const },
  },
};

export const agentVersionRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  const lineageWhere = (a: {
    key: string;
    scope: string;
    teamId: string | null;
    orgId: string | null;
    channelId: string | null;
    workflowTemplateId: string | null;
  }) => ({
    channelId: a.channelId,
    key: a.key,
    orgId: a.orgId,
    scope: a.scope as AgentScope,
    teamId: a.teamId,
    workflowTemplateId: a.workflowTemplateId,
  });

  app.get(
    '/agent-library/:id/versions',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const agent = await fastify.prisma.agent.findUnique({ where: { id: request.params.id } });
      if (!agent) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
      }
      const versions = await runUnscoped(
        'admin reads the version history of one agent lineage at any scope',
        ['Agent'],
        () =>
          fastify.prisma.agent.findMany({
            include: WITH_SKILLS,
            orderBy: { version: 'desc' },
            where: lineageWhere(agent),
          })
      );
      const authorIds = [
        ...new Set(versions.map((v) => v.createdById).filter(Boolean)),
      ] as string[];
      const authors =
        authorIds.length > 0
          ? await fastify.prisma.user.findMany({
              select: { email: true, id: true },
              where: { id: { in: authorIds } },
            })
          : [];
      const emailById = new Map(authors.map((u) => [u.id, u.email]));
      return {
        data: versions.map((v) => ({
          ...v,
          createdByEmail: v.createdById ? (emailById.get(v.createdById) ?? null) : null,
        })),
      };
    }
  );

  app.post(
    '/agent-library/:id/restore',
    { onRequest: adminOnly, schema: { body: RestoreBody, params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const anchor = await fastify.prisma.agent.findUnique({ where: { id: request.params.id } });
      if (!anchor) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
      }
      const where = lineageWhere(anchor);
      const source = await fastify.prisma.agent.findFirst({
        include: WITH_SKILLS,
        where: { ...where, id: request.body.versionId },
      });
      if (!source) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'That version does not belong to this agent' },
        });
      }
      const latest = await fastify.prisma.agent.findFirst({
        orderBy: { version: 'desc' },
        where,
      });
      if (!latest) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
      }
      const { agent, catalogWarnings, scanWarnings } = await updateAgent(
        fastify.prisma,
        latest,
        {
          credentialId: source.credentialId,
          description: source.description,
          inheritsModelFrom: source.inheritsModelFrom,
          mcpConnectionId: source.mcpConnectionId,
          modelSpec: source.modelSpec,
          name: source.name,
          skillRefs: source.skillRefs.map((r) => ({ skillId: r.skillId, sortOrder: r.sortOrder })),
          // An unchanged prompt is left out so restoring other fields keeps verification.
          ...(source.systemPrompt !== latest.systemPrompt
            ? { systemPrompt: source.systemPrompt }
            : {}),
          toolKeys: (source.toolKeys as string[] | null) ?? null,
        },
        actor.sub
      );
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: { restoredFromVersion: source.version, version: agent.version },
        before: { version: latest.version },
        entityId: agent.id,
        entityType: 'Agent',
      });
      return reply.status(201).send({
        data: agent,
        ...(scanWarnings.length > 0 ? { scanWarnings } : {}),
        ...(catalogWarnings.length > 0 ? { catalogWarnings } : {}),
      });
    }
  );
};
