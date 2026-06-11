import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import {
  checkTeamAccess,
  clearSkillAssignments,
  deleteToolConfig,
  findToolConfig,
  getAgentRolesOverview,
  IMPLEMENTER_TOOL_KEYS,
  listSkillAssignments,
  replaceSkillAssignments,
  SKILL_AGENT_ROLES,
  SKILL_SCOPES,
  setToolConfig,
  validateScopeRefs,
} from '../lib/skillAssignmentService.js';
import {
  createSkill,
  getSkillEffectivenessReport,
  updateSkill,
} from '../lib/skillLibraryService.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Admin-only CRUD routes for the Skills library and AgentSkillAssignment management.
 *
 * Skills (prompt fragments only — tools are configured via AgentToolConfig):
 *   GET    /api/v1/admin/skills              List all skills
 *   POST   /api/v1/admin/skills              Create a non-built-in skill
 *   GET    /api/v1/admin/skills/:id          Get skill by ID
 *   PUT    /api/v1/admin/skills/:id          Update skill
 *   DELETE /api/v1/admin/skills/:id          Delete skill (rejects built-in)
 *
 * Agent skill assignments (admin global scope):
 *   GET    /api/v1/admin/agents                          List all roles with GLOBAL skill counts + tool configs
 *   GET    /api/v1/admin/agents/:role/skills             Get skill assignments for role+scope
 *   PUT    /api/v1/admin/agents/:role/skills             Replace assignments for role+scope
 *   DELETE /api/v1/admin/agents/:role/skills             Clear assignments for role+scope
 *
 * Agent tool config (admin):
 *   GET    /api/v1/admin/agents/:role/tools              Get effective tool config for role+scope
 *   PUT    /api/v1/admin/agents/:role/tools              Set tool config for role+scope
 *   DELETE /api/v1/admin/agents/:role/tools              Delete tool config for role+scope
 *
 * Team-scoped agent skill assignments:
 *   GET    /api/v1/teams/:teamId/skills                  Read-only skill library (team members)
 *   GET    /api/v1/teams/:teamId/agents/:role/skills     Team-scoped skill assignments
 *   PUT    /api/v1/teams/:teamId/agents/:role/skills     Set team-scoped assignments
 *   DELETE /api/v1/teams/:teamId/agents/:role/skills     Reset to global assignments
 *
 * Team-scoped agent tool config:
 *   GET    /api/v1/teams/:teamId/agents/:role/tools      Get team-scoped tool config
 *   PUT    /api/v1/teams/:teamId/agents/:role/tools      Set team-scoped tool config
 *   DELETE /api/v1/teams/:teamId/agents/:role/tools      Delete team-scoped tool config
 *
 * Business logic (the partial-unique-index-safe write patterns, team access
 * checks, skill content scanning) lives in `lib/skillAssignmentService.ts`
 * and `lib/skillLibraryService.ts` — the admin and team-scoped plugins call
 * the same service functions, parameterized by scope.
 */

// ── Validation schemas ──────────────────────────────────────────────────────

const SkillIdParams = z.object({ id: z.string().uuid() });
const AgentRoleParams = z.object({ role: z.enum(SKILL_AGENT_ROLES) });

const CreateSkillSchema = z.object({
  description: z.string().max(1000).optional(),
  name: z.string().min(1).max(200),
  promptText: z.string().min(1).max(50_000),
});

const UpdateSkillSchema = z.object({
  description: z.string().max(1000).optional(),
  isActive: z.boolean().optional(),
  name: z.string().min(1).max(200).optional(),
  promptText: z.string().min(1).max(50_000).optional(),
});

const ListSkillsQuery = z.object({});

const scopeKeysValid = (v: { scope: string; teamId?: string; workflowTemplateId?: string }) =>
  (v.scope === 'GLOBAL' && !v.teamId && !v.workflowTemplateId) ||
  (v.scope === 'TEAM' && !!v.teamId && !v.workflowTemplateId) ||
  (v.scope === 'WORKFLOW_TEMPLATE' && !v.teamId && !!v.workflowTemplateId);

const SCOPE_KEYS_ERROR =
  'scope=TEAM requires teamId only; scope=WORKFLOW_TEMPLATE requires workflowTemplateId only; scope=GLOBAL forbids both';

const SkillAssignmentBody = z
  .object({
    scope: z.enum(SKILL_SCOPES),
    skillIds: z.array(z.string().uuid()).max(50),
    sortOrders: z.array(z.number().int().min(0)).optional(),
    teamId: z.string().uuid().optional(),
    workflowTemplateId: z.string().uuid().optional(),
  })
  .refine(scopeKeysValid, { message: SCOPE_KEYS_ERROR });

const SkillAssignmentQuery = z.object({
  scope: z.enum(SKILL_SCOPES).default('GLOBAL'),
  teamId: z.string().uuid().optional(),
  workflowTemplateId: z.string().uuid().optional(),
});

const ToolConfigBody = z
  .object({
    enabledTools: z.array(z.enum(IMPLEMENTER_TOOL_KEYS)).min(1).max(4),
    scope: z.enum(SKILL_SCOPES),
    teamId: z.string().uuid().optional(),
    workflowTemplateId: z.string().uuid().optional(),
  })
  .refine(scopeKeysValid, { message: SCOPE_KEYS_ERROR });

const ToolConfigQuery = z.object({
  scope: z.enum(SKILL_SCOPES).default('GLOBAL'),
  teamId: z.string().uuid().optional(),
  workflowTemplateId: z.string().uuid().optional(),
});

const TeamAgentParams = z.object({ role: z.enum(SKILL_AGENT_ROLES), teamId: z.string().uuid() });

// ── Skills CRUD routes ──────────────────────────────────────────────────────

export const skillsRoutes: FastifyPluginAsync = fp(async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  // GET /api/v1/admin/skills
  app.get(
    '/skills',
    { onRequest: adminOnly, schema: { querystring: ListSkillsQuery } },
    async () => {
      const skills = await fastify.prisma.skill.findMany({
        include: { _count: { select: { assignments: true } } },
        orderBy: [{ isBuiltIn: 'desc' }, { name: 'asc' }],
      });
      return { data: skills.map((s) => ({ ...s, usedByCount: s._count.assignments })) };
    }
  );

  // GET /api/v1/admin/skills/effectiveness — correlational report: run
  // outcomes for runs where each skill was active vs the all-runs baseline.
  app.get(
    '/skills/effectiveness',
    {
      onRequest: adminOnly,
      schema: {
        querystring: z.object({
          windowDays: z.coerce.number().int().min(1).max(365).default(30),
        }),
      },
    },
    async (request) => ({
      data: await getSkillEffectivenessReport(fastify.prisma, request.query.windowDays),
    })
  );

  // POST /api/v1/admin/skills
  app.post(
    '/skills',
    { onRequest: adminOnly, schema: { body: CreateSkillSchema } },
    async (request, reply) => {
      const actor = requireUser(request);
      const { name, description, promptText } = request.body;
      const { skill, scanWarnings } = await createSkill(fastify.prisma, request.body);
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor,
        after: { description, name, promptText },
        entityId: skill.id,
        entityType: 'Skill',
      });
      return reply.status(201).send({
        data: skill,
        ...(scanWarnings.length > 0 ? { scanWarnings } : {}),
      });
    }
  );

  // GET /api/v1/admin/skills/:id
  app.get(
    '/skills/:id',
    { onRequest: adminOnly, schema: { params: SkillIdParams } },
    async (request, reply) => {
      const skill = await fastify.prisma.skill.findUnique({
        include: { _count: { select: { assignments: true } } },
        where: { id: request.params.id },
      });
      if (!skill) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Skill not found' } });
      }
      return { data: { ...skill, usedByCount: skill._count.assignments } };
    }
  );

  // PUT /api/v1/admin/skills/:id
  app.put(
    '/skills/:id',
    { onRequest: adminOnly, schema: { body: UpdateSkillSchema, params: SkillIdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.skill.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Skill not found' } });
      }

      const { updated, scanWarnings } = await updateSkill(fastify.prisma, existing, request.body);
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: {
          description: updated.description,
          isActive: updated.isActive,
          name: updated.name,
          promptText: updated.promptText,
        },
        before: {
          description: existing.description,
          isActive: existing.isActive,
          name: existing.name,
          promptText: existing.promptText,
        },
        entityId: existing.id,
        entityType: 'Skill',
      });
      return {
        data: updated,
        ...(scanWarnings.length > 0 ? { scanWarnings } : {}),
      };
    }
  );

  // DELETE /api/v1/admin/skills/:id
  app.delete(
    '/skills/:id',
    { onRequest: adminOnly, schema: { params: SkillIdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.skill.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Skill not found' } });
      }
      if (existing.isBuiltIn) {
        return reply.status(403).send({
          error: {
            code: 'BUILTIN_SKILL',
            message: 'Built-in skills cannot be deleted. Use the isActive flag to disable them.',
          },
        });
      }
      await fastify.prisma.skill.delete({ where: { id: request.params.id } });
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor,
        before: { description: existing.description, name: existing.name },
        entityId: existing.id,
        entityType: 'Skill',
      });
      return reply.status(204).send();
    }
  );

  // ── Agent role overview ────────────────────────────────────────────────────

  // GET /api/v1/admin/agents — list all roles with their GLOBAL skill counts + tool configs
  app.get('/agents', { onRequest: adminOnly }, async () => ({
    data: await getAgentRolesOverview(fastify.prisma),
  }));

  // GET /api/v1/admin/agents/:role/skills
  app.get(
    '/agents/:role/skills',
    {
      onRequest: adminOnly,
      schema: { params: AgentRoleParams, querystring: SkillAssignmentQuery },
    },
    async (request) => {
      const { role } = request.params;
      const assignments = await listSkillAssignments(fastify.prisma, {
        agentRole: role,
        ...request.query,
      });
      return { data: assignments };
    }
  );

  // PUT /api/v1/admin/agents/:role/skills — replace assignments for role+scope
  app.put(
    '/agents/:role/skills',
    { onRequest: adminOnly, schema: { body: SkillAssignmentBody, params: AgentRoleParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const { role } = request.params;
      const { scope, skillIds, sortOrders, teamId, workflowTemplateId } = request.body;

      // Validate FK references before the transaction to surface a 400 instead
      // of a FK constraint violation (which would be an unhandled 500).
      const refError = await validateScopeRefs(fastify.prisma, { teamId, workflowTemplateId });
      if (refError) {
        return reply.status(400).send({ error: { code: 'NOT_FOUND', message: refError } });
      }

      const updated = await replaceSkillAssignments(
        fastify.prisma,
        { agentRole: role, scope, teamId, workflowTemplateId },
        skillIds,
        sortOrders
      );
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: { agentRole: role, scope, skillIds, teamId, workflowTemplateId },
        entityId: randomUUID(),
        entityType: 'AgentSkillAssignment',
      });
      return { data: updated };
    }
  );

  // DELETE /api/v1/admin/agents/:role/skills — clear all assignments for role+scope
  app.delete(
    '/agents/:role/skills',
    {
      onRequest: adminOnly,
      schema: { params: AgentRoleParams, querystring: SkillAssignmentQuery },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const { role } = request.params;
      const { scope, teamId, workflowTemplateId } = request.query;
      await clearSkillAssignments(fastify.prisma, {
        agentRole: role,
        scope,
        teamId,
        workflowTemplateId,
      });
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor,
        before: { agentRole: role, scope, teamId, workflowTemplateId },
        entityId: randomUUID(),
        entityType: 'AgentSkillAssignment',
      });
      return reply.status(204).send();
    }
  );

  // ── Agent tool config routes (admin) ─────────────────────────────────────

  // GET /api/v1/admin/agents/:role/tools
  app.get(
    '/agents/:role/tools',
    { onRequest: adminOnly, schema: { params: AgentRoleParams, querystring: ToolConfigQuery } },
    async (request, reply) => {
      const config = await findToolConfig(fastify.prisma, {
        agentRole: request.params.role,
        ...request.query,
      });
      if (!config) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'No tool config for this role+scope' },
        });
      }
      return { data: config };
    }
  );

  // PUT /api/v1/admin/agents/:role/tools — set tool config for role+scope
  app.put(
    '/agents/:role/tools',
    { onRequest: adminOnly, schema: { body: ToolConfigBody, params: AgentRoleParams } },
    async (request) => {
      const actor = requireUser(request);
      const { role } = request.params;
      const { scope, enabledTools, teamId, workflowTemplateId } = request.body;

      const [existing, config] = await setToolConfig(
        fastify.prisma,
        { agentRole: role, scope, teamId, workflowTemplateId },
        enabledTools
      );
      await writeAuditLog(fastify, {
        action: existing ? 'UPDATE' : 'CREATE',
        actor,
        after: { agentRole: role, enabledTools, scope, teamId, workflowTemplateId },
        before: existing ? { enabledTools: existing.enabledTools } : undefined,
        entityId: config.id,
        entityType: 'AgentToolConfig',
      });
      return { data: config };
    }
  );

  // DELETE /api/v1/admin/agents/:role/tools — resets to inherit from parent scope
  app.delete(
    '/agents/:role/tools',
    { onRequest: adminOnly, schema: { params: AgentRoleParams, querystring: ToolConfigQuery } },
    async (request, reply) => {
      const actor = requireUser(request);
      const { role } = request.params;
      const { scope, teamId, workflowTemplateId } = request.query;
      const existing = await deleteToolConfig(fastify.prisma, {
        agentRole: role,
        scope,
        teamId,
        workflowTemplateId,
      });
      if (existing) {
        await writeAuditLog(fastify, {
          action: 'DELETE',
          actor,
          before: {
            agentRole: role,
            enabledTools: existing.enabledTools,
            scope,
            teamId,
            workflowTemplateId,
          },
          entityId: existing.id,
          entityType: 'AgentToolConfig',
        });
      }
      return reply.status(204).send();
    }
  );
});

// ── Team-scoped agent skill routes ─────────────────────────────────────────

const TeamIdParams = z.object({ teamId: z.string().uuid() });

export const teamAgentSkillRoutes: FastifyPluginAsync = fp(async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const engineer = requireAuth({ requiredRole: 'ENGINEER' });

  // GET /api/v1/teams/:teamId/skills — non-admin read-only skill library for team members.
  // Team owners (ENGINEER role) need to see all skills so they can assign them without
  // hitting the admin-only /api/v1/admin/skills endpoint.
  app.get(
    '/:teamId/skills',
    { onRequest: engineer, schema: { params: TeamIdParams } },
    async (request, reply) => {
      const { teamId } = request.params;
      const user = requireUser(request);

      // Check access: platform ADMIN or team member
      const access = await checkTeamAccess(fastify.prisma, user, teamId);
      if (!access.ok) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: access.message } });
      }

      const skills = await fastify.prisma.skill.findMany({
        orderBy: [{ isBuiltIn: 'desc' }, { name: 'asc' }],
        select: {
          description: true,
          id: true,
          isBuiltIn: true,
          name: true,
          promptText: true,
        },
      });
      return { data: skills };
    }
  );

  // GET /api/v1/teams/:teamId/agents/:role/skills
  app.get(
    '/:teamId/agents/:role/skills',
    { onRequest: engineer, schema: { params: TeamAgentParams } },
    async (request, reply) => {
      const { teamId, role } = request.params;
      const user = requireUser(request);

      // Check access: platform ADMIN or team member
      const access = await checkTeamAccess(fastify.prisma, user, teamId);
      if (!access.ok) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: access.message } });
      }

      // Return the TEAM-scoped assignments; also include GLOBAL assignments
      // so the UI can show what the "inherit" baseline looks like.
      const [teamAssignments, globalAssignments] = await Promise.all([
        listSkillAssignments(fastify.prisma, { agentRole: role, scope: 'TEAM', teamId }),
        listSkillAssignments(fastify.prisma, { agentRole: role, scope: 'GLOBAL' }),
      ]);

      return {
        data: {
          globalAssignments,
          hasTeamOverride: teamAssignments.length > 0,
          teamAssignments,
        },
      };
    }
  );

  // PUT /api/v1/teams/:teamId/agents/:role/skills
  app.put(
    '/:teamId/agents/:role/skills',
    {
      onRequest: engineer,
      schema: {
        body: z.object({
          skillIds: z.array(z.string().uuid()).max(50),
          sortOrders: z.array(z.number().int().min(0)).optional(),
        }),
        params: TeamAgentParams,
      },
    },
    async (request, reply) => {
      const { teamId, role } = request.params;
      const { skillIds, sortOrders } = request.body;
      const user = requireUser(request);

      // Check access: platform ADMIN or team ADMIN
      const access = await checkTeamAccess(fastify.prisma, user, teamId, {
        requireTeamAdmin: true,
      });
      if (!access.ok) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: access.message } });
      }

      const updated = await replaceSkillAssignments(
        fastify.prisma,
        { agentRole: role, scope: 'TEAM', teamId },
        skillIds,
        sortOrders
      );
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: user,
        after: { agentRole: role, scope: 'TEAM', skillIds, teamId },
        entityId: randomUUID(),
        entityType: 'AgentSkillAssignment',
      });
      return reply.send({ data: updated });
    }
  );

  // DELETE /api/v1/teams/:teamId/agents/:role/skills — reset to global
  app.delete(
    '/:teamId/agents/:role/skills',
    { onRequest: engineer, schema: { params: TeamAgentParams } },
    async (request, reply) => {
      const { teamId, role } = request.params;
      const user = requireUser(request);

      // Check access: platform ADMIN or team ADMIN
      const access = await checkTeamAccess(fastify.prisma, user, teamId, {
        requireTeamAdmin: true,
      });
      if (!access.ok) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: access.message } });
      }

      await clearSkillAssignments(fastify.prisma, { agentRole: role, scope: 'TEAM', teamId });
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor: user,
        before: { agentRole: role, scope: 'TEAM', teamId },
        entityId: randomUUID(),
        entityType: 'AgentSkillAssignment',
      });
      return reply.status(204).send();
    }
  );

  // ── Team-scoped agent tool config routes ──────────────────────────────────

  // GET /api/v1/teams/:teamId/agents/:role/tools
  app.get(
    '/:teamId/agents/:role/tools',
    { onRequest: engineer, schema: { params: TeamAgentParams } },
    async (request, reply) => {
      const { teamId, role } = request.params;
      const user = requireUser(request);

      // Check access: platform ADMIN or team member
      const access = await checkTeamAccess(fastify.prisma, user, teamId);
      if (!access.ok) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: access.message } });
      }

      const [teamConfig, globalConfig] = await Promise.all([
        findToolConfig(fastify.prisma, { agentRole: role, scope: 'TEAM', teamId }),
        findToolConfig(fastify.prisma, { agentRole: role, scope: 'GLOBAL' }),
      ]);

      return {
        data: {
          globalConfig,
          hasTeamOverride: !!teamConfig,
          teamConfig,
        },
      };
    }
  );

  // PUT /api/v1/teams/:teamId/agents/:role/tools — set team-scoped tool config
  app.put(
    '/:teamId/agents/:role/tools',
    {
      onRequest: engineer,
      schema: {
        body: z.object({
          enabledTools: z.array(z.enum(IMPLEMENTER_TOOL_KEYS)).min(1).max(4),
        }),
        params: TeamAgentParams,
      },
    },
    async (request, reply) => {
      const { teamId, role } = request.params;
      const { enabledTools } = request.body;
      const user = requireUser(request);

      // Check access: platform ADMIN or team ADMIN
      const access = await checkTeamAccess(fastify.prisma, user, teamId, {
        requireTeamAdmin: true,
      });
      if (!access.ok) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: access.message } });
      }

      const [existingTeamTool, config] = await setToolConfig(
        fastify.prisma,
        { agentRole: role, scope: 'TEAM', teamId },
        enabledTools
      );
      await writeAuditLog(fastify, {
        action: existingTeamTool ? 'UPDATE' : 'CREATE',
        actor: user,
        after: { agentRole: role, enabledTools, scope: 'TEAM', teamId },
        before: existingTeamTool ? { enabledTools: existingTeamTool.enabledTools } : undefined,
        entityId: config.id,
        entityType: 'AgentToolConfig',
      });
      return reply.send({ data: config });
    }
  );

  // DELETE /api/v1/teams/:teamId/agents/:role/tools — reset to global
  app.delete(
    '/:teamId/agents/:role/tools',
    { onRequest: engineer, schema: { params: TeamAgentParams } },
    async (request, reply) => {
      const { teamId, role } = request.params;
      const user = requireUser(request);

      // Check access: platform ADMIN or team ADMIN
      const access = await checkTeamAccess(fastify.prisma, user, teamId, {
        requireTeamAdmin: true,
      });
      if (!access.ok) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: access.message } });
      }

      const existingTeamToolDel = await deleteToolConfig(fastify.prisma, {
        agentRole: role,
        scope: 'TEAM',
        teamId,
      });
      if (existingTeamToolDel) {
        await writeAuditLog(fastify, {
          action: 'DELETE',
          actor: user,
          before: {
            agentRole: role,
            enabledTools: existingTeamToolDel.enabledTools,
            scope: 'TEAM',
            teamId,
          },
          entityId: existingTeamToolDel.id,
          entityType: 'AgentToolConfig',
        });
      }
      return reply.status(204).send();
    }
  );
});
