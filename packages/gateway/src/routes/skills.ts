import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Admin-only CRUD routes for the Skills library and AgentSkillAssignment management.
 *
 * Skills:
 *   GET    /api/v1/admin/skills              List all skills (filterable by type)
 *   POST   /api/v1/admin/skills              Create a non-built-in skill
 *   GET    /api/v1/admin/skills/:id          Get skill by ID
 *   PUT    /api/v1/admin/skills/:id          Update skill
 *   DELETE /api/v1/admin/skills/:id          Delete skill (rejects built-in)
 *
 * Agent skill assignments (admin global scope):
 *   GET    /api/v1/admin/agents                          List all roles with GLOBAL skill counts
 *   GET    /api/v1/admin/agents/:role/skills             Get skill assignments for role+scope
 *   PUT    /api/v1/admin/agents/:role/skills             Replace assignments for role+scope
 *   DELETE /api/v1/admin/agents/:role/skills             Clear assignments for role+scope
 *
 * Team-scoped agent skill assignments:
 *   GET    /api/v1/teams/:teamId/agents/:role/skills     Team-scoped skill assignments
 *   PUT    /api/v1/teams/:teamId/agents/:role/skills     Set team-scoped assignments
 */

// ── Validation schemas ──────────────────────────────────────────────────────

const SKILL_TYPES = ['TOOL', 'PROMPT_FRAGMENT'] as const;
const TOOL_KEYS = ['readFile', 'writeFile', 'listDirectory', 'bash'] as const;
const AGENT_ROLES = [
  'IMPLEMENTER',
  'REVIEWER',
  'PLANNER',
  'SECURITY_REVIEW',
  'VALIDATE_CONTEXT',
  'COMMIT_TO_MEMORY',
] as const;
const SCOPE_VALUES = ['GLOBAL', 'TEAM', 'WORKFLOW_TEMPLATE'] as const;

const SkillIdParams = z.object({ id: z.string().uuid() });
const AgentRoleParams = z.object({ role: z.enum(AGENT_ROLES) });

const CreateSkillSchema = z
  .object({
    description: z.string().max(1000).optional(),
    name: z.string().min(1).max(200),
    promptText: z.string().max(50_000).optional(),
    toolKey: z.enum(TOOL_KEYS).optional(),
    type: z.enum(SKILL_TYPES),
  })
  .refine(
    (v) => (v.type === 'TOOL' && !!v.toolKey) || (v.type === 'PROMPT_FRAGMENT' && !!v.promptText),
    { message: 'TOOL skills require toolKey; PROMPT_FRAGMENT skills require promptText' }
  );

const UpdateSkillSchema = z.object({
  description: z.string().max(1000).optional(),
  name: z.string().min(1).max(200).optional(),
  promptText: z.string().max(50_000).nullable().optional(),
  toolKey: z.enum(TOOL_KEYS).nullable().optional(),
  type: z.enum(SKILL_TYPES).optional(),
});

const ListSkillsQuery = z.object({
  type: z.enum(SKILL_TYPES).optional(),
});

const SkillAssignmentBody = z
  .object({
    scope: z.enum(SCOPE_VALUES),
    skillIds: z.array(z.string().uuid()).max(50),
    sortOrders: z.array(z.number().int().min(0)).optional(),
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

const SkillAssignmentQuery = z.object({
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
    async (request) => {
      const { type } = request.query;
      const skills = await fastify.prisma.skill.findMany({
        include: { _count: { select: { assignments: true } } },
        orderBy: [{ isBuiltIn: 'desc' }, { name: 'asc' }],
        where: type ? { type } : undefined,
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
      const { name, description, type, toolKey, promptText } = request.body;
      const skill = await fastify.prisma.skill.create({
        data: {
          description,
          isBuiltIn: false,
          name,
          promptText,
          toolKey,
          type,
        },
      });
      return reply.status(201).send({ data: skill });
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
      const existing = await fastify.prisma.skill.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Skill not found' } });
      }

      const { name, description, type, toolKey, promptText } = request.body;

      // Built-in skills: only allow name and description to be updated
      const updateData = existing.isBuiltIn
        ? { description, name }
        : { description, name, promptText, toolKey, type };

      const updated = await fastify.prisma.skill.update({
        data: updateData,
        where: { id: request.params.id },
      });
      return { data: updated };
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
      return reply.status(204).send();
    }
  );

  // ── Agent role overview ────────────────────────────────────────────────────

  // GET /api/v1/admin/agents — list all roles with their GLOBAL skill counts
  app.get('/agents', { onRequest: requireAuth({ requiredRole: 'ADMIN' }) }, async () => {
    const roles = [
      'IMPLEMENTER',
      'REVIEWER',
      'PLANNER',
      'SECURITY_REVIEW',
      'VALIDATE_CONTEXT',
      'COMMIT_TO_MEMORY',
    ] as const;

    const assignments = await fastify.prisma.agentSkillAssignment.groupBy({
      _count: { id: true },
      by: ['agentRole'],
      where: { scope: 'GLOBAL' },
    });

    const countByRole = Object.fromEntries(assignments.map((a) => [a.agentRole, a._count.id]));

    return {
      data: roles.map((role) => ({
        globalSkillCount: countByRole[role] ?? 0,
        role,
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
      schema: { params: TeamIdParams, querystring: ListSkillsQuery },
    },
    async (request, reply) => {
      const { teamId } = request.params;
      const { type } = request.query;
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
          toolKey: true,
          type: true,
        },
        where: type ? { type } : undefined,
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
      return reply.status(204).send();
    }
  );
});
