import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { checkTeamAccess } from '../lib/skillAssignmentService.js';
import {
  createSkill,
  getSkillEffectivenessReport,
  updateSkill,
} from '../lib/skillLibraryService.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Admin CRUD for the Skills library + a team-scoped read-only skill list.
 *
 * Skills are prompt fragments. They are attached to agents via the Agent
 * library's `skillRefs` (`/api/v1/admin/agent-library`) — the per-role
 * AgentSkillAssignment / AgentToolConfig routes were retired in P1.5.
 *
 *   GET    /api/v1/admin/skills              List all skills
 *   GET    /api/v1/admin/skills/effectiveness
 *   POST   /api/v1/admin/skills              Create a custom skill
 *   GET    /api/v1/admin/skills/:id          Get skill by ID
 *   PUT    /api/v1/admin/skills/:id          Update skill
 *   DELETE /api/v1/admin/skills/:id          Delete skill (rejects built-in)
 *   GET    /api/v1/teams/:teamId/skills      Read-only skill library (team members)
 */

// ── Validation schemas ──────────────────────────────────────────────────────

const SkillIdParams = z.object({ id: z.string().uuid() });

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

// ── Skills CRUD routes (admin) ──────────────────────────────────────────────

export const skillsRoutes: FastifyPluginAsync = fp(async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  // GET /api/v1/admin/skills — `usedByCount` is how many Agents reference it.
  app.get(
    '/skills',
    { onRequest: adminOnly, schema: { querystring: ListSkillsQuery } },
    async () => {
      const skills = await fastify.prisma.skill.findMany({
        include: { _count: { select: { agentSkillRefs: true } } },
        orderBy: [{ isBuiltIn: 'desc' }, { name: 'asc' }],
      });
      return { data: skills.map((s) => ({ ...s, usedByCount: s._count.agentSkillRefs })) };
    }
  );

  // GET /api/v1/admin/skills/effectiveness — correlational report.
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
        include: { _count: { select: { agentSkillRefs: true } } },
        where: { id: request.params.id },
      });
      if (!skill) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Skill not found' } });
      }
      return { data: { ...skill, usedByCount: skill._count.agentSkillRefs } };
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
});

// ── Team-scoped read-only skill library ─────────────────────────────────────

const TeamIdParams = z.object({ teamId: z.string().uuid() });

export const teamAgentSkillRoutes: FastifyPluginAsync = fp(async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const engineer = requireAuth({ requiredRole: 'ENGINEER' });

  // GET /api/v1/teams/:teamId/skills — read-only skill library for team members,
  // so team owners can pick skills for their TEAM-scope agents without the
  // admin-only /api/v1/admin/skills endpoint.
  app.get(
    '/:teamId/skills',
    { onRequest: engineer, schema: { params: TeamIdParams } },
    async (request, reply) => {
      const { teamId } = request.params;
      const user = requireUser(request);

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
});
