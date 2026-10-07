import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { IMPLEMENTER_RUNTIMES } from '@auto-swe/shared/types/api';
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
  defaultOverrideRuntime,
  inheritingHarnessWarnings,
  listAgents,
  mergedRuntimeAndModel,
  runtimeSaveError,
  updateAgent,
  validateAgentScopeRefs,
  validateMcpConnectionRef,
} from '../lib/agentLibraryService.js';
import { writeAuditLog } from '../lib/auditLog.js';
import { booleanQueryParam } from '../lib/queryParams.js';
import { checkTeamAccess } from '../lib/skillAssignmentService.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const AGENT_SCOPES = ['GLOBAL', 'ORGANIZATION', 'TEAM', 'CHANNEL', 'WORKFLOW_TEMPLATE'] as const;

const ListQuery = z.object({
  all: booleanQueryParam(false),
  channelId: z.string().uuid().optional(),
  orgId: z.string().uuid().optional(),
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
  runtime: z.enum(IMPLEMENTER_RUNTIMES).nullable().optional(),
  skillRefs: z
    .array(z.object({ skillId: z.string().uuid(), sortOrder: z.number().int().min(0) }))
    .nullable()
    .optional(),
  systemPrompt: z.string().max(50_000).nullable().optional(),
  toolKeys: z.array(z.enum(AGENT_TOOL_KEYS)).nullable().optional(),
};

/**
 * The runtime decides what runs inside the trust boundary and which credential
 * enters the workspace, so changing it takes a platform ADMIN, the same floor as
 * the `workspace.implementerRuntime` setting. A team admin's write that leaves
 * it out (or restates the current value) keeps whatever an ADMIN chose.
 */
function runtimeChangeForbidden(
  actorRole: string,
  requested: string | null | undefined,
  current: string | null
): boolean {
  return actorRole !== 'ADMIN' && requested !== undefined && requested !== current;
}

const RUNTIME_ADMIN_ONLY = {
  error: {
    code: 'FORBIDDEN',
    message: "Only a platform admin can change an agent's runtime.",
  },
} as const;

function runtimeModelMismatch(message: string) {
  return { error: { code: 'RUNTIME_MODEL_MISMATCH', message } };
}

const CreateAgentSchema = z
  .object({
    ...AgentBaseFields,
    channelId: z.string().uuid().optional(),
    key: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_.-]+$/, 'key may contain letters, digits, dot, dash, underscore'),
    orgId: z.string().uuid().optional(),
    scope: z.enum(AGENT_SCOPES),
    teamId: z.string().uuid().optional(),
    workflowTemplateId: z.string().uuid().optional(),
  })
  .refine(
    (v) =>
      (v.scope === 'GLOBAL' && !v.teamId && !v.orgId && !v.channelId && !v.workflowTemplateId) ||
      (v.scope === 'ORGANIZATION' &&
        !!v.orgId &&
        !v.teamId &&
        !v.channelId &&
        !v.workflowTemplateId) ||
      (v.scope === 'TEAM' && !!v.teamId && !v.orgId && !v.channelId && !v.workflowTemplateId) ||
      (v.scope === 'CHANNEL' && !!v.channelId && !v.teamId && !v.orgId && !v.workflowTemplateId) ||
      (v.scope === 'WORKFLOW_TEMPLATE' &&
        !v.teamId &&
        !v.orgId &&
        !v.channelId &&
        !!v.workflowTemplateId),
    {
      message:
        'scope=TEAM requires teamId only; scope=ORGANIZATION requires orgId only; scope=CHANNEL requires channelId only; scope=WORKFLOW_TEMPLATE requires workflowTemplateId only; scope=GLOBAL forbids all',
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
      // Every filter here is an optional query parameter, so the unfiltered
      // call — the admin library view with nothing selected — is the normal
      // case, not an oversight.
      const rows = await runUnscoped(
        "admin lists the Agent library across every team's scopes",
        ['Agent'],
        () =>
          listAgents(fastify.prisma, {
            channelId: request.query.channelId,
            latestOnly: !request.query.all,
            orgId: request.query.orgId,
            scope: request.query.scope,
            teamId: request.query.teamId,
            workflowTemplateId: request.query.workflowTemplateId,
          })
      );
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
          orgId: agent.orgId,
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
        channelId: body.channelId,
        orgId: body.orgId,
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
      const named = {
        inheritsModelFrom: body.inheritsModelFrom ?? null,
        modelSpec: body.modelSpec ?? null,
      };
      const runtime =
        body.runtime !== undefined
          ? body.runtime
          : await defaultOverrideRuntime(fastify.prisma, body, named);
      const runtimeError = await runtimeSaveError(fastify.prisma, { ...named, runtime });
      if (runtimeError) {
        return reply.status(400).send(runtimeModelMismatch(runtimeError));
      }
      const key: AgentScopeKey = {
        channelId: body.channelId,
        key: body.key,
        orgId: body.orgId,
        scope: body.scope,
        teamId: body.teamId,
        workflowTemplateId: body.workflowTemplateId,
      };
      try {
        const { agent, catalogWarnings, scanWarnings } = await createAgent(
          fastify.prisma,
          key,
          { ...body, runtime },
          actor.sub
        );
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor,
          after: { key: agent.key, name: agent.name, scope: agent.scope },
          entityId: agent.id,
          entityType: 'Agent',
        });
        return reply.status(201).send({
          data: agent,
          ...(scanWarnings.length > 0 ? { scanWarnings } : {}),
          ...(catalogWarnings.length > 0 ? { catalogWarnings } : {}),
        });
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
      const merged = mergedRuntimeAndModel(current, request.body);
      const runtimeError = await runtimeSaveError(fastify.prisma, merged);
      if (runtimeError) {
        return reply.status(400).send(runtimeModelMismatch(runtimeError));
      }
      const { agent, catalogWarnings, scanWarnings } = await updateAgent(
        fastify.prisma,
        current,
        request.body,
        actor.sub
      );
      // A new model can strand harness agents that inherit it: say so, refuse nothing.
      const runtimeWarnings =
        request.body.modelSpec !== undefined
          ? await inheritingHarnessWarnings(fastify.prisma, agent.key, agent.modelSpec)
          : [];
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: { modelSpec: agent.modelSpec, runtime: agent.runtime, version: agent.version },
        before: {
          modelSpec: current.modelSpec,
          runtime: current.runtime,
          version: current.version,
        },
        entityId: agent.id,
        entityType: 'Agent',
      });
      return reply.send({
        data: agent,
        ...(scanWarnings.length > 0 ? { scanWarnings } : {}),
        ...(catalogWarnings.length > 0 ? { catalogWarnings } : {}),
        ...(runtimeWarnings.length > 0 ? { runtimeWarnings } : {}),
      });
    }
  );

  app.delete(
    '/agent-library/:id',
    {
      onRequest: adminOnly,
      schema: { params: IdParams, querystring: z.object({ force: booleanQueryParam(false) }) },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const current = await fastify.prisma.agent.findUnique({ where: { id: request.params.id } });
      if (!current) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
      }
      // A GLOBAL row is the last tier of the cascade: with no fallback past it, runs that need the
      // key fail and the worker refuses to start. That is allowed, but only on purpose.
      if (current.scope === 'GLOBAL' && current.isBuiltIn && !request.query.force) {
        return reply.status(409).send({
          error: {
            code: 'BUILTIN_AGENT_REQUIRES_FORCE',
            message: `'${current.key}' is a built-in agent with no fallback. Runs that need it will fail and the worker will refuse to start if it is required. Repeat the request with force=true to deactivate it anyway.`,
          },
        });
      }
      const count = await deactivateAgentLineage(fastify.prisma, {
        channelId: current.channelId,
        key: current.key,
        orgId: current.orgId,
        scope: current.scope as AgentScope,
        teamId: current.teamId,
        workflowTemplateId: current.workflowTemplateId,
      });
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor,
        after: { force: request.query.force === true, isBuiltIn: current.isBuiltIn },
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

  // Any team member may read the agent keys an override can name — key, display name and model
  // only, never a prompt, tool list or connection. The full library stays team-admin / ADMIN.
  const teamMember = requireAuth({
    requiredRole: 'ENGINEER',
    requiredTeamRole: 'ENGINEER',
    teamIdParam: 'id',
  });

  app.get(
    '/:id/agent-library/options',
    { onRequest: teamMember, schema: { params: TeamParams } },
    async (request) => {
      const rows = await fastify.prisma.agent.findMany({
        orderBy: [{ key: 'asc' }, { version: 'desc' }],
        select: { key: true, modelSpec: true, name: true, scope: true },
        where: {
          isActive: true,
          OR: [{ scope: 'GLOBAL' }, { scope: 'TEAM', teamId: request.params.id }],
        },
      });
      // One entry per key; a team's own agent shadows the GLOBAL one it overrides.
      const byKey = new Map<string, (typeof rows)[number]>();
      for (const r of rows) {
        const seen = byKey.get(r.key);
        if (!seen || (seen.scope === 'GLOBAL' && r.scope === 'TEAM')) {
          byKey.set(r.key, r);
        }
      }
      return {
        data: [...byKey.values()].map(({ key, modelSpec, name }) => ({ key, modelSpec, name })),
      };
    }
  );

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
      const named = {
        inheritsModelFrom: request.body.inheritsModelFrom ?? null,
        modelSpec: request.body.modelSpec ?? null,
      };
      // A new TEAM override starts on the platform-wide row's runtime; only an
      // ADMIN may name another.
      const inherited = await defaultOverrideRuntime(
        fastify.prisma,
        { key: request.body.key, scope: 'TEAM' },
        named
      );
      if (runtimeChangeForbidden(actor.role, request.body.runtime, inherited)) {
        return reply.status(403).send(RUNTIME_ADMIN_ONLY);
      }
      const runtime = request.body.runtime !== undefined ? request.body.runtime : inherited;
      const runtimeError = await runtimeSaveError(fastify.prisma, { ...named, runtime });
      if (runtimeError) {
        return reply.status(400).send(runtimeModelMismatch(runtimeError));
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
      const key: AgentScopeKey = {
        key: request.body.key,
        scope: 'TEAM',
        teamId: request.params.id,
      };
      try {
        const { agent, catalogWarnings, scanWarnings } = await createAgent(
          fastify.prisma,
          key,
          { ...request.body, runtime },
          actor.sub
        );
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor,
          after: { key: agent.key, name: agent.name, scope: 'TEAM', teamId: request.params.id },
          entityId: agent.id,
          entityType: 'Agent',
        });
        return reply.status(201).send({
          data: agent,
          ...(scanWarnings.length > 0 ? { scanWarnings } : {}),
          ...(catalogWarnings.length > 0 ? { catalogWarnings } : {}),
        });
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
      if (runtimeChangeForbidden(actor.role, request.body.runtime, current.runtime)) {
        return reply.status(403).send(RUNTIME_ADMIN_ONLY);
      }
      const merged = mergedRuntimeAndModel(current, request.body);
      const runtimeError = await runtimeSaveError(fastify.prisma, merged);
      if (runtimeError) {
        return reply.status(400).send(runtimeModelMismatch(runtimeError));
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
      const { agent, catalogWarnings, scanWarnings } = await updateAgent(
        fastify.prisma,
        current,
        request.body,
        actor.sub
      );
      // A new model can strand harness agents that inherit it: say so, refuse nothing.
      const runtimeWarnings =
        request.body.modelSpec !== undefined
          ? await inheritingHarnessWarnings(
              fastify.prisma,
              agent.key,
              agent.modelSpec,
              // A team admin is not told about other teams' agents.
              actor.role === 'ADMIN' ? undefined : request.params.id
            )
          : [];
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: { modelSpec: agent.modelSpec, runtime: agent.runtime, version: agent.version },
        before: {
          key: current.key,
          modelSpec: current.modelSpec,
          runtime: current.runtime,
          scope: 'TEAM',
          teamId: current.teamId,
          version: current.version,
        },
        entityId: agent.id,
        entityType: 'Agent',
      });
      return reply.send({
        data: agent,
        ...(scanWarnings.length > 0 ? { scanWarnings } : {}),
        ...(catalogWarnings.length > 0 ? { catalogWarnings } : {}),
        ...(runtimeWarnings.length > 0 ? { runtimeWarnings } : {}),
      });
    }
  );

  app.delete(
    '/:id/agent-library/:agentId',
    { onRequest: teamAdmin, schema: { params: TeamAgentParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const current = await fastify.prisma.agent.findUnique({
        where: { id: request.params.agentId },
      });
      if (current?.scope !== 'TEAM' || current.teamId !== request.params.id) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
      }
      const access = await checkTeamAccess(fastify.prisma, actor, request.params.id, {
        requireTeamAdmin: true,
      });
      if (!access.ok) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: access.message } });
      }
      const count = await deactivateAgentLineage(fastify.prisma, {
        key: current.key,
        scope: 'TEAM',
        teamId: current.teamId,
      });
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor,
        before: { key: current.key, scope: 'TEAM', teamId: current.teamId },
        entityId: current.id,
        entityType: 'Agent',
      });
      return reply.send({ data: { deactivated: count } });
    }
  );
};
