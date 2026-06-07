import { randomUUID } from 'node:crypto';
import { scanSkillContent } from '@auto-swe/shared/lib/skillScanner';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
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
 */

// ── Validation schemas ──────────────────────────────────────────────────────

const TOOL_KEYS = ['readFile', 'writeFile', 'listDirectory', 'bash'] as const;
const AGENT_ROLES = [
  'IMPLEMENTER',
  'REVIEWER',
  'PLANNER',
  'SECURITY_REVIEW',
  'VALIDATE_CONTEXT',
  'COMMIT_TO_MEMORY',
  'SECURITY_REVIEWER',
  'DOMAIN_LOGIC_REVIEWER',
  'PERFORMANCE_REVIEWER',
  'DECOMPOSER',
] as const;
const SCOPE_VALUES = ['GLOBAL', 'TEAM', 'WORKFLOW_TEMPLATE'] as const;

const SkillIdParams = z.object({ id: z.string().uuid() });
const AgentRoleParams = z.object({ role: z.enum(AGENT_ROLES) });

const CreateSkillSchema = z.object({
  description: z.string().max(1000).optional(),
  name: z.string().min(1).max(200),
  promptText: z.string().min(1).max(50_000),
});

const UpdateSkillSchema = z.object({
  description: z.string().max(1000).optional(),
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
    scope: z.enum(SCOPE_VALUES),
    skillIds: z.array(z.string().uuid()).max(50),
    sortOrders: z.array(z.number().int().min(0)).optional(),
    teamId: z.string().uuid().optional(),
    workflowTemplateId: z.string().uuid().optional(),
  })
  .refine(scopeKeysValid, { message: SCOPE_KEYS_ERROR });

const SkillAssignmentQuery = z.object({
  scope: z.enum(SCOPE_VALUES).default('GLOBAL'),
  teamId: z.string().uuid().optional(),
  workflowTemplateId: z.string().uuid().optional(),
});

const ToolConfigBody = z
  .object({
    enabledTools: z.array(z.enum(TOOL_KEYS)).min(1).max(4),
    scope: z.enum(SCOPE_VALUES),
    teamId: z.string().uuid().optional(),
    workflowTemplateId: z.string().uuid().optional(),
  })
  .refine(scopeKeysValid, { message: SCOPE_KEYS_ERROR });

const ToolConfigQuery = z.object({
  scope: z.enum(SCOPE_VALUES).default('GLOBAL'),
  teamId: z.string().uuid().optional(),
  workflowTemplateId: z.string().uuid().optional(),
});

const TeamAgentParams = z.object({ role: z.enum(AGENT_ROLES), teamId: z.string().uuid() });

// ── Skills CRUD routes ──────────────────────────────────────────────────────

export const skillsRoutes: FastifyPluginAsync = fp(async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/admin/skills
  app.get(
    '/skills',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { querystring: ListSkillsQuery },
    },
    async () => {
      const skills = await fastify.prisma.skill.findMany({
        include: { _count: { select: { assignments: true } } },
        orderBy: [{ isBuiltIn: 'desc' }, { name: 'asc' }],
      });
      return { data: skills.map((s) => ({ ...s, usedByCount: s._count.assignments })) };
    }
  );

  // POST /api/v1/admin/skills
  app.post(
    '/skills',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { body: CreateSkillSchema },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const { name, description, promptText } = request.body;
      const scanResult = await scanSkillContent(promptText);
      const skill = await fastify.prisma.skill.create({
        data: {
          description,
          isBuiltIn: false,
          isVerified: false,
          name,
          promptText,
        },
      });
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor,
        after: { description, name, promptText },
        entityId: skill.id,
        entityType: 'Skill',
      });
      return reply.status(201).send({
        data: skill,
        ...(scanResult.warnings.length > 0 ? { scanWarnings: scanResult.warnings } : {}),
      });
    }
  );

  // GET /api/v1/admin/skills/:id
  app.get(
    '/skills/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { params: SkillIdParams },
    },
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
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { body: UpdateSkillSchema, params: SkillIdParams },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.skill.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Skill not found' } });
      }

      const { name, description, promptText } = request.body;

      // Built-in skills: only allow name and description to be updated.
      // Custom skills: scan promptText for injection/exfiltration patterns (non-blocking).
      // Reset isVerified only when promptText changes — name/description edits don't
      // invalidate the content trust signal.
      const updateData = existing.isBuiltIn
        ? { description, name }
        : {
            description,
            name,
            promptText,
            ...(promptText !== undefined ? { isVerified: false } : {}),
          };

      const scanResult =
        !existing.isBuiltIn && promptText
          ? await scanSkillContent(promptText)
          : { safe: true, warnings: [] };

      const updated = await fastify.prisma.skill.update({
        data: updateData,
        where: { id: request.params.id },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: {
          description: updated.description,
          name: updated.name,
          promptText: updated.promptText,
        },
        before: {
          description: existing.description,
          name: existing.name,
          promptText: existing.promptText,
        },
        entityId: existing.id,
        entityType: 'Skill',
      });
      return {
        data: updated,
        ...(scanResult.warnings.length > 0 ? { scanWarnings: scanResult.warnings } : {}),
      };
    }
  );

  // DELETE /api/v1/admin/skills/:id
  app.delete(
    '/skills/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { params: SkillIdParams },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.skill.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Skill not found' } });
      }
      if (existing.isBuiltIn) {
        return reply.status(400).send({
          error: {
            code: 'BUILTIN_SKILL',
            message: 'Built-in skills cannot be deleted',
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
  app.get('/agents', { onRequest: requireAuth({ requiredRole: 'ADMIN' }) }, async () => {
    const roles = AGENT_ROLES;

    const [assignments, toolConfigs] = await Promise.all([
      fastify.prisma.agentSkillAssignment.groupBy({
        _count: { id: true },
        by: ['agentRole'],
        where: { scope: 'GLOBAL' },
      }),
      fastify.prisma.agentToolConfig.findMany({
        where: { scope: 'GLOBAL' },
      }),
    ]);

    const countByRole = Object.fromEntries(assignments.map((a) => [a.agentRole, a._count.id]));
    const toolConfigByRole = Object.fromEntries(toolConfigs.map((tc) => [tc.agentRole, tc]));

    return {
      data: roles.map((role) => ({
        globalSkillCount: countByRole[role] ?? 0,
        role,
        toolConfig: toolConfigByRole[role] ?? null,
      })),
    };
  });

  // GET /api/v1/admin/agents/:role/skills
  app.get(
    '/agents/:role/skills',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { params: AgentRoleParams, querystring: SkillAssignmentQuery },
    },
    async (request) => {
      const { role } = request.params;
      const { scope, teamId, workflowTemplateId } = request.query;
      const assignments = await fastify.prisma.agentSkillAssignment.findMany({
        include: { skill: true },
        orderBy: { sortOrder: 'asc' },
        where: {
          agentRole: role,
          scope,
          teamId: teamId ?? null,
          workflowTemplateId: workflowTemplateId ?? null,
        },
      });
      return { data: assignments };
    }
  );

  // PUT /api/v1/admin/agents/:role/skills — replace assignments for role+scope
  app.put(
    '/agents/:role/skills',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { body: SkillAssignmentBody, params: AgentRoleParams },
    },
    async (request, reply) => {
      const { role } = request.params;
      const { scope, skillIds, sortOrders, teamId, workflowTemplateId } = request.body;
      requireUser(request);

      // Validate FK references before the transaction to surface a 400 instead
      // of a FK constraint violation (which would be an unhandled 500).
      if (teamId) {
        const teamExists = await fastify.prisma.team.findUnique({
          select: { id: true },
          where: { id: teamId },
        });
        if (!teamExists) {
          return reply
            .status(400)
            .send({ error: { code: 'NOT_FOUND', message: 'Team not found' } });
        }
      }
      if (workflowTemplateId) {
        const tplExists = await fastify.prisma.workflowTemplate.findUnique({
          select: { id: true },
          where: { id: workflowTemplateId },
        });
        if (!tplExists) {
          return reply
            .status(400)
            .send({ error: { code: 'NOT_FOUND', message: 'Workflow template not found' } });
        }
      }

      await fastify.prisma.$transaction(async (tx) => {
        // Delete existing assignments for this role+scope
        await tx.agentSkillAssignment.deleteMany({
          where: {
            agentRole: role,
            scope,
            teamId: teamId ?? null,
            workflowTemplateId: workflowTemplateId ?? null,
          },
        });

        // Create new assignments
        if (skillIds.length > 0) {
          await tx.agentSkillAssignment.createMany({
            data: skillIds.map((skillId, idx) => ({
              agentRole: role,
              scope,
              skillId,
              sortOrder: sortOrders?.[idx] ?? idx,
              teamId: teamId ?? null,
              workflowTemplateId: workflowTemplateId ?? null,
            })),
          });
        }
      });

      const updated = await fastify.prisma.agentSkillAssignment.findMany({
        include: { skill: true },
        orderBy: { sortOrder: 'asc' },
        where: {
          agentRole: role,
          scope,
          teamId: teamId ?? null,
          workflowTemplateId: workflowTemplateId ?? null,
        },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: requireUser(request),
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
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { params: AgentRoleParams, querystring: SkillAssignmentQuery },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const { role } = request.params;
      const { scope, teamId, workflowTemplateId } = request.query;
      await fastify.prisma.agentSkillAssignment.deleteMany({
        where: {
          agentRole: role,
          scope,
          teamId: teamId ?? null,
          workflowTemplateId: workflowTemplateId ?? null,
        },
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
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { params: AgentRoleParams, querystring: ToolConfigQuery },
    },
    async (request, reply) => {
      const { role } = request.params;
      const { scope, teamId, workflowTemplateId } = request.query;
      const config = await fastify.prisma.agentToolConfig.findFirst({
        where: {
          agentRole: role,
          scope,
          teamId: teamId ?? null,
          workflowTemplateId: workflowTemplateId ?? null,
        },
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
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { body: ToolConfigBody, params: AgentRoleParams },
    },
    async (request) => {
      const actor = requireUser(request);
      const { role } = request.params;
      const { scope, enabledTools, teamId, workflowTemplateId } = request.body;

      // deleteMany + create in a transaction (partial unique indexes prevent upsert on named constraint)
      const [existing, config] = await fastify.prisma.$transaction(async (tx) => {
        const prev = await tx.agentToolConfig.findFirst({
          where: {
            agentRole: role,
            scope,
            teamId: teamId ?? null,
            workflowTemplateId: workflowTemplateId ?? null,
          },
        });
        await tx.agentToolConfig.deleteMany({
          where: {
            agentRole: role,
            scope,
            teamId: teamId ?? null,
            workflowTemplateId: workflowTemplateId ?? null,
          },
        });
        const next = await tx.agentToolConfig.create({
          data: {
            agentRole: role,
            enabledTools,
            scope,
            teamId: teamId ?? null,
            workflowTemplateId: workflowTemplateId ?? null,
          },
        });
        return [prev, next] as const;
      });
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
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { params: AgentRoleParams, querystring: ToolConfigQuery },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const { role } = request.params;
      const { scope, teamId, workflowTemplateId } = request.query;
      const existing = await fastify.prisma.agentToolConfig.findFirst({
        where: {
          agentRole: role,
          scope,
          teamId: teamId ?? null,
          workflowTemplateId: workflowTemplateId ?? null,
        },
      });
      await fastify.prisma.agentToolConfig.deleteMany({
        where: {
          agentRole: role,
          scope,
          teamId: teamId ?? null,
          workflowTemplateId: workflowTemplateId ?? null,
        },
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

  // GET /api/v1/teams/:teamId/skills — non-admin read-only skill library for team members.
  // Team owners (ENGINEER role) need to see all skills so they can assign them without
  // hitting the admin-only /api/v1/admin/skills endpoint.
  app.get(
    '/:teamId/skills',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: TeamIdParams },
    },
    async (request, reply) => {
      const { teamId } = request.params;
      const user = requireUser(request);

      // Check access: platform ADMIN or team member
      if (user.role !== 'ADMIN') {
        const membership = await fastify.prisma.teamMembership.findUnique({
          where: { userId_teamId: { teamId, userId: user.sub } },
        });
        if (!membership) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'Team membership required' },
          });
        }
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
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: TeamAgentParams },
    },
    async (request, reply) => {
      const { teamId, role } = request.params;
      const user = requireUser(request);

      // Check access: platform ADMIN or team member
      if (user.role !== 'ADMIN') {
        const membership = await fastify.prisma.teamMembership.findUnique({
          where: { userId_teamId: { teamId, userId: user.sub } },
        });
        if (!membership) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'Team membership required' },
          });
        }
      }

      // Return the TEAM-scoped assignments; also include GLOBAL assignments
      // so the UI can show what the "inherit" baseline looks like.
      const [teamAssignments, globalAssignments] = await Promise.all([
        fastify.prisma.agentSkillAssignment.findMany({
          include: { skill: true },
          orderBy: { sortOrder: 'asc' },
          where: { agentRole: role, scope: 'TEAM', teamId },
        }),
        fastify.prisma.agentSkillAssignment.findMany({
          include: { skill: true },
          orderBy: { sortOrder: 'asc' },
          where: { agentRole: role, scope: 'GLOBAL' },
        }),
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
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
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
      if (user.role !== 'ADMIN') {
        const membership = await fastify.prisma.teamMembership.findUnique({
          where: { userId_teamId: { teamId, userId: user.sub } },
        });
        if (!membership) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'Team membership required' },
          });
        }
        if (membership.role !== 'ADMIN') {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'Team admin role required' },
          });
        }
      }

      await fastify.prisma.$transaction(async (tx) => {
        // Delete existing TEAM-scoped assignments
        await tx.agentSkillAssignment.deleteMany({
          where: { agentRole: role, scope: 'TEAM', teamId },
        });

        if (skillIds.length > 0) {
          await tx.agentSkillAssignment.createMany({
            data: skillIds.map((skillId, idx) => ({
              agentRole: role,
              scope: 'TEAM' as const,
              skillId,
              sortOrder: sortOrders?.[idx] ?? idx,
              teamId,
            })),
          });
        }
      });

      const updated = await fastify.prisma.agentSkillAssignment.findMany({
        include: { skill: true },
        orderBy: { sortOrder: 'asc' },
        where: { agentRole: role, scope: 'TEAM', teamId },
      });
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
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: TeamAgentParams },
    },
    async (request, reply) => {
      const { teamId, role } = request.params;
      const user = requireUser(request);

      // Check access: platform ADMIN or team ADMIN
      if (user.role !== 'ADMIN') {
        const membership = await fastify.prisma.teamMembership.findUnique({
          where: { userId_teamId: { teamId, userId: user.sub } },
        });
        if (!membership) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'Team membership required' },
          });
        }
        if (membership.role !== 'ADMIN') {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'Team admin role required' },
          });
        }
      }

      await fastify.prisma.agentSkillAssignment.deleteMany({
        where: { agentRole: role, scope: 'TEAM', teamId },
      });
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
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: TeamAgentParams },
    },
    async (request, reply) => {
      const { teamId, role } = request.params;
      const user = requireUser(request);

      // Check access: platform ADMIN or team member
      if (user.role !== 'ADMIN') {
        const membership = await fastify.prisma.teamMembership.findUnique({
          where: { userId_teamId: { teamId, userId: user.sub } },
        });
        if (!membership) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'Team membership required' },
          });
        }
      }

      const [teamConfig, globalConfig] = await Promise.all([
        fastify.prisma.agentToolConfig.findFirst({
          where: { agentRole: role, scope: 'TEAM', teamId },
        }),
        fastify.prisma.agentToolConfig.findFirst({
          where: { agentRole: role, scope: 'GLOBAL' },
        }),
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
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: {
        body: z.object({
          enabledTools: z.array(z.enum(TOOL_KEYS)).min(1).max(4),
        }),
        params: TeamAgentParams,
      },
    },
    async (request, reply) => {
      const { teamId, role } = request.params;
      const { enabledTools } = request.body;
      const user = requireUser(request);

      // Check access: platform ADMIN or team ADMIN
      if (user.role !== 'ADMIN') {
        const membership = await fastify.prisma.teamMembership.findUnique({
          where: { userId_teamId: { teamId, userId: user.sub } },
        });
        if (!membership) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'Team membership required' },
          });
        }
        if (membership.role !== 'ADMIN') {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'Team admin role required' },
          });
        }
      }

      const [existingTeamTool, config] = await fastify.prisma.$transaction(async (tx) => {
        const prev = await tx.agentToolConfig.findFirst({
          where: { agentRole: role, scope: 'TEAM', teamId },
        });
        await tx.agentToolConfig.deleteMany({
          where: { agentRole: role, scope: 'TEAM', teamId },
        });
        const next = await tx.agentToolConfig.create({
          data: {
            agentRole: role,
            enabledTools,
            scope: 'TEAM',
            teamId,
          },
        });
        return [prev, next] as const;
      });
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
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: TeamAgentParams },
    },
    async (request, reply) => {
      const { teamId, role } = request.params;
      const user = requireUser(request);

      // Check access: platform ADMIN or team ADMIN
      if (user.role !== 'ADMIN') {
        const membership = await fastify.prisma.teamMembership.findUnique({
          where: { userId_teamId: { teamId, userId: user.sub } },
        });
        if (!membership) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'Team membership required' },
          });
        }
        if (membership.role !== 'ADMIN') {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'Team admin role required' },
          });
        }
      }

      const existingTeamToolDel = await fastify.prisma.agentToolConfig.findFirst({
        where: { agentRole: role, scope: 'TEAM', teamId },
      });
      await fastify.prisma.agentToolConfig.deleteMany({
        where: { agentRole: role, scope: 'TEAM', teamId },
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
