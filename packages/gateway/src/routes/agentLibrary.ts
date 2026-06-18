import { AGENT_TOOL_KEYS } from '@auto-swe/shared/workflow';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AgentLineageExistsError,
  type AgentScope,
  type AgentScopeKey,
  createAgent,
  deactivateAgentLineage,
  listAgents,
  updateAgent,
  validateAgentScopeRefs,
  validateMcpConnectionRef,
} from '../lib/agentLibraryService.js';
import { writeAuditLog } from '../lib/auditLog.js';
import { checkTeamAccess } from '../lib/skillAssignmentService.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const AGENT_SCOPES = ['GLOBAL', 'TEAM', 'WORKFLOW_TEMPLATE'] as const;

const ListQuery = z.object({
  all: z.coerce.boolean().optional(),
  scope: z.enum(AGENT_SCOPES).optional(),
  teamId: z.string().uuid().optional(),
  workflowTemplateId: z.string().uuid().optional(),
});

const AgentBaseFields = {
  credentialId: z.string().uuid().nullable().optional(),
  description: z.string().max(2_000).nullable().optional(),
  inheritsModelFrom: z.string().max(100).nullable().optional(),
  mcpConnectionId: z.string().uuid().nullable().optional(),
  modelSpec: z.string().max(200).nullable().optional(),
  name: z.string().min(1).max(200),
  skillRefs: z
    .array(z.object({ skillId: z.string().uuid(), sortOrder: z.number().int().min(0) }))
    .nullable()
    .optional(),
  systemPrompt: z.string().max(50_000).nullable().optional(),
  toolKeys: z.array(z.enum(AGENT_TOOL_KEYS)).nullable().optional(),
};

const CreateAgentSchema = z
  .object({
    ...AgentBaseFields,
    key: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_.-]+$/, 'key may contain letters, digits, dot, dash, underscore'),
    scope: z.enum(AGENT_SCOPES),
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

const UpdateAgentSchema = z.object({ ...AgentBaseFields, name: AgentBaseFields.name.optional() });

const IdParams = z.object({ id: z.string().uuid() });

/** Admin-only Agent library: create/version/list/delete across all scopes. */
export const agentLibraryRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  app.get(
    '/agent-library',
    { onRequest: adminOnly, schema: { querystring: ListQuery } },
    async (request) => {
      const rows = await listAgents(fastify.prisma, {
        latestOnly: !request.query.all,
        scope: request.query.scope,
        teamId: request.query.teamId,
        workflowTemplateId: request.query.workflowTemplateId,
      });
      return { data: rows };
    }
  );

  app.get(
    '/agent-library/:id',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const agent = await fastify.prisma.agent.findUnique({
        include: { skillRefs: { include: { skill: { select: { id: true, name: true } } } } },
        where: { id: request.params.id },
      });
      if (!agent) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
      }
      // Include the full version history of this lineage.
      const versions = await fastify.prisma.agent.findMany({
        orderBy: { version: 'desc' },
        select: { createdAt: true, id: true, isActive: true, isVerified: true, version: true },
        where: {
          key: agent.key,
          scope: agent.scope,
          teamId: agent.teamId,
          workflowTemplateId: agent.workflowTemplateId,
        },
      });
      return { data: { ...agent, versions } };
    }
  );

  app.post(
    '/agent-library',
    { onRequest: adminOnly, schema: { body: CreateAgentSchema } },
    async (request, reply) => {
      const actor = requireUser(request);
      const body = request.body;
      const refError = await validateAgentScopeRefs(fastify.prisma, {
        teamId: body.teamId,
        workflowTemplateId: body.workflowTemplateId,
      });
      if (refError) {
        return reply.status(400).send({ error: { code: 'NOT_FOUND', message: refError } });
      }
      const mcpError = await validateMcpConnectionRef(fastify.prisma, body.mcpConnectionId, {
        scope: body.scope,
        teamId: body.teamId,
      });
      if (mcpError) {
        return reply
          .status(400)
          .send({ error: { code: 'INVALID_MCP_CONNECTION', message: mcpError } });
      }
      const key: AgentScopeKey = {
        key: body.key,
        scope: body.scope,
        teamId: body.teamId,
        workflowTemplateId: body.workflowTemplateId,
      };
      try {
        const { agent, scanWarnings } = await createAgent(fastify.prisma, key, body, actor.sub);
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor,
          after: { key: agent.key, name: agent.name, scope: agent.scope },
          entityId: agent.id,
          entityType: 'Agent',
        });
        return reply
          .status(201)
          .send({ data: agent, ...(scanWarnings.length > 0 ? { scanWarnings } : {}) });
      } catch (err) {
        if (err instanceof AgentLineageExistsError) {
          return reply.status(409).send({ error: { code: 'CONFLICT', message: err.message } });
        }
        throw err;
      }
    }
  );

  app.put(
    '/agent-library/:id',
    { onRequest: adminOnly, schema: { body: UpdateAgentSchema, params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const current = await fastify.prisma.agent.findUnique({ where: { id: request.params.id } });
      if (!current) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
      }
      const mcpError = await validateMcpConnectionRef(
        fastify.prisma,
        request.body.mcpConnectionId,
        {
          scope: current.scope as AgentScope,
          teamId: current.teamId,
        }
      );
      if (mcpError) {
        return reply
          .status(400)
          .send({ error: { code: 'INVALID_MCP_CONNECTION', message: mcpError } });
      }
      const { agent, scanWarnings } = await updateAgent(
        fastify.prisma,
        current,
        request.body,
        actor.sub
      );
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: { version: agent.version },
        before: { version: current.version },
        entityId: agent.id,
        entityType: 'Agent',
      });
      return reply.send({ data: agent, ...(scanWarnings.length > 0 ? { scanWarnings } : {}) });
    }
  );

  app.delete(
    '/agent-library/:id',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const current = await fastify.prisma.agent.findUnique({ where: { id: request.params.id } });
      if (!current) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
      }
      const count = await deactivateAgentLineage(fastify.prisma, {
        key: current.key,
        scope: current.scope as AgentScope,
        teamId: current.teamId,
        workflowTemplateId: current.workflowTemplateId,
      });
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor,
        before: { key: current.key, scope: current.scope },
        entityId: current.id,
        entityType: 'Agent',
      });
      return reply.send({ data: { deactivated: count } });
    }
  );
};

/** Team-owner Agent library: TEAM-scope agents for a single team. */
export const teamAgentLibraryRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const teamAdmin = requireAuth({
    requiredRole: 'ENGINEER',
    requiredTeamRole: 'ADMIN',
    teamIdParam: 'id',
  });
  const TeamParams = z.object({ id: z.string().uuid() });
  const TeamAgentParams = z.object({ agentId: z.string().uuid(), id: z.string().uuid() });
  const TeamCreate = z.object(AgentBaseFields).extend({
    key: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_.-]+$/, 'invalid key'),
  });

  app.get(
    '/:id/agent-library',
    { onRequest: teamAdmin, schema: { params: TeamParams } },
    async (request) => {
      const rows = await listAgents(fastify.prisma, { scope: 'TEAM', teamId: request.params.id });
      return { data: rows };
    }
  );

  app.post(
    '/:id/agent-library',
    { onRequest: teamAdmin, schema: { body: TeamCreate, params: TeamParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const mcpError = await validateMcpConnectionRef(
        fastify.prisma,
        request.body.mcpConnectionId,
        {
          scope: 'TEAM',
          teamId: request.params.id,
        }
      );
      if (mcpError) {
        return reply
          .status(400)
          .send({ error: { code: 'INVALID_MCP_CONNECTION', message: mcpError } });
      }
      const key: AgentScopeKey = {
        key: request.body.key,
        scope: 'TEAM',
        teamId: request.params.id,
      };
      try {
        const { agent, scanWarnings } = await createAgent(
          fastify.prisma,
          key,
          request.body,
          actor.sub
        );
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor,
          after: { key: agent.key, name: agent.name, scope: 'TEAM', teamId: request.params.id },
          entityId: agent.id,
          entityType: 'Agent',
        });
        return reply
          .status(201)
          .send({ data: agent, ...(scanWarnings.length > 0 ? { scanWarnings } : {}) });
      } catch (err) {
        if (err instanceof AgentLineageExistsError) {
          return reply.status(409).send({ error: { code: 'CONFLICT', message: err.message } });
        }
        throw err;
      }
    }
  );

  app.put(
    '/:id/agent-library/:agentId',
    {
      onRequest: teamAdmin,
      schema: { body: z.object(AgentBaseFields).partial(), params: TeamAgentParams },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const current = await fastify.prisma.agent.findUnique({
        where: { id: request.params.agentId },
      });
      // Confine team owners to their own team's TEAM-scope agents.
      if (current?.scope !== 'TEAM' || current.teamId !== request.params.id) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
      }
      const access = await checkTeamAccess(fastify.prisma, actor, request.params.id, {
        requireTeamAdmin: true,
      });
      if (!access.ok) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: access.message } });
      }
      const mcpError = await validateMcpConnectionRef(
        fastify.prisma,
        request.body.mcpConnectionId,
        {
          scope: 'TEAM',
          teamId: request.params.id,
        }
      );
      if (mcpError) {
        return reply
          .status(400)
          .send({ error: { code: 'INVALID_MCP_CONNECTION', message: mcpError } });
      }
      const { agent, scanWarnings } = await updateAgent(
        fastify.prisma,
        current,
        request.body,
        actor.sub
      );
      return reply.send({ data: agent, ...(scanWarnings.length > 0 ? { scanWarnings } : {}) });
    }
  );
};
