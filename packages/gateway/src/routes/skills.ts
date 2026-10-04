import { MAX_SKILL_PROMPT_TEXT_LENGTH } from '@auto-swe/shared/lib/regexSafety';
import { isRevisionConflict } from '@auto-swe/shared/lib/skillRevision';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { checkTeamAccess } from '../lib/skillAssignmentService.js';
import {
  createSkill,
  getSkillEffectivenessReport,
  skillVisibilityWhere,
  updateSkill,
  verifySkill,
} from '../lib/skillLibraryService.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Admin CRUD for the Skills library + a team-scoped read-only skill list.
 *
 * Skills are prompt fragments. They are attached to agents via the Agent
 * library's `skillRefs` (`/api/v1/platform/agent-library`) — the per-role
 * AgentSkillAssignment / AgentToolConfig routes were retired in P1.5.
 *
 *   GET    /api/v1/platform/skills              List all skills
 *   GET    /api/v1/platform/skills/effectiveness
 *   POST   /api/v1/platform/skills              Create a custom skill
 *   GET    /api/v1/platform/skills/:id          Get skill by ID
 *   PUT    /api/v1/platform/skills/:id          Update skill
 *   POST   /api/v1/platform/skills/:id/verify   Mark the current revision human-verified
 *   DELETE /api/v1/platform/skills/:id          Delete skill (rejects built-in)
 *   GET    /api/v1/teams/:teamId/skills      Read-only skill library (team members)
 */

// ── Validation schemas ──────────────────────────────────────────────────────

const SkillIdParams = z.object({ id: z.string().uuid() });

const CreateSkillSchema = z.object({
  description: z.string().max(1000).optional(),
  name: z.string().min(1).max(200),
  promptText: z.string().min(1).max(MAX_SKILL_PROMPT_TEXT_LENGTH),
});

const UpdateSkillSchema = z.object({
  description: z.string().max(1000).optional(),
  isActive: z.boolean().optional(),
  name: z.string().min(1).max(200).optional(),
  promptText: z.string().min(1).max(MAX_SKILL_PROMPT_TEXT_LENGTH).optional(),
});

const UpdateSkillWithRevisionSchema = UpdateSkillSchema.extend({
  // The revision the editor read. When present, an edit of a skill that has moved
  // on is refused with 409 instead of overwriting text the editor never saw.
  expectedRevision: z.number().int().positive().optional(),
});

// The revision the admin read and is attesting to; there is no default, because
// "verify whatever is current" is exactly the unseen-text hole.
const VerifySkillSchema = z.object({ revision: z.number().int().positive() });

const ListSkillsQuery = z.object({});

// ── Skills CRUD routes (admin) ──────────────────────────────────────────────

export const skillsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  const skillChanged = (reply: FastifyReply) =>
    reply.status(409).send({
      error: {
        code: 'SKILL_CHANGED',
        message: 'The skill changed since you read it; reload it and try again.',
      },
    });

  // A revision-guarded write that matched no row (P2025) means one of three
  // things, and only one of them is a lost race: the skill was deleted (404), a
  // newer revision exists (409), or neither — e.g. the author row to connect is
  // gone — which is a real failure and must not read as a conflict.
  async function revisionErrorReply(
    err: unknown,
    readRow: { id: string; currentRevision: number },
    reply: FastifyReply
  ) {
    if (!isRevisionConflict(err)) {
      throw err;
    }
    const now = await fastify.prisma.skill.findUnique({
      select: { currentRevision: true },
      where: { id: readRow.id },
    });
    if (!now) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Skill not found' } });
    }
    if (now.currentRevision === readRow.currentRevision) {
      throw err;
    }
    return skillChanged(reply);
  }

  // GET /api/v1/platform/skills — `usedByCount` is how many Agents reference it.
  app.get(
    '/skills',
    { onRequest: adminOnly, schema: { querystring: ListSkillsQuery } },
    async () => {
      const skills = await runUnscoped('admin skill library spans every team', ['Skill'], () =>
        fastify.prisma.skill.findMany({
          include: { _count: { select: { agentSkillRefs: true } } },
          orderBy: [{ isBuiltIn: 'desc' }, { name: 'asc' }],
        })
      );
      return { data: skills.map((s) => ({ ...s, usedByCount: s._count.agentSkillRefs })) };
    }
  );

  // GET /api/v1/platform/skills/effectiveness — correlational report.
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

  // POST /api/v1/platform/skills
  app.post(
    '/skills',
    { onRequest: adminOnly, schema: { body: CreateSkillSchema } },
    async (request, reply) => {
      const actor = requireUser(request);
      const { name, description, promptText } = request.body;
      const { skill, scanWarnings } = await createSkill(fastify.prisma, {
        ...request.body,
        createdById: actor.sub,
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
        ...(scanWarnings.length > 0 ? { scanWarnings } : {}),
      });
    }
  );

  // GET /api/v1/platform/skills/:id
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

  // PUT /api/v1/platform/skills/:id
  app.put(
    '/skills/:id',
    {
      onRequest: adminOnly,
      schema: { body: UpdateSkillWithRevisionSchema, params: SkillIdParams },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.skill.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Skill not found' } });
      }

      if (
        request.body.expectedRevision !== undefined &&
        request.body.expectedRevision !== existing.currentRevision
      ) {
        return skillChanged(reply);
      }

      let result: Awaited<ReturnType<typeof updateSkill>>;
      try {
        result = await updateSkill(fastify.prisma, existing, request.body, actor.sub);
      } catch (err) {
        return revisionErrorReply(err, existing, reply);
      }
      const { updated, scanWarnings } = result;
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

  // POST /api/v1/platform/skills/:id/verify — the only place isVerified becomes
  // true: an admin attests to the text of the CURRENT revision. Any later content
  // edit clears it (updateSkill).
  app.post(
    '/skills/:id/verify',
    { onRequest: adminOnly, schema: { body: VerifySkillSchema, params: SkillIdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.skill.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Skill not found' } });
      }
      if (request.body.revision !== existing.currentRevision) {
        return skillChanged(reply);
      }
      let verified: Awaited<ReturnType<typeof verifySkill>>;
      try {
        verified = await verifySkill(fastify.prisma, existing.id, request.body.revision);
      } catch (err) {
        return revisionErrorReply(err, existing, reply);
      }
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: { isVerified: true, revision: verified.currentRevision },
        before: { isVerified: existing.isVerified, revision: existing.currentRevision },
        entityId: existing.id,
        entityType: 'Skill',
      });
      return { data: verified };
    }
  );

  // DELETE /api/v1/platform/skills/:id
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
};

// ── Team-scoped read-only skill library ─────────────────────────────────────

const TeamIdParams = z.object({ teamId: z.string().uuid() });

export const teamAgentSkillRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const engineer = requireAuth({ requiredRole: 'ENGINEER' });

  // GET /api/v1/teams/:teamId/skills — read-only skill library for team members,
  // so team owners can pick skills for their TEAM-scope agents without the
  // admin-only /api/v1/platform/skills endpoint.
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

      const team = await fastify.prisma.team.findUnique({
        select: { orgId: true },
        where: { id: teamId },
      });
      const skills = await fastify.prisma.skill.findMany({
        orderBy: [{ isBuiltIn: 'desc' }, { name: 'asc' }],
        select: {
          description: true,
          id: true,
          isBuiltIn: true,
          name: true,
          promptText: true,
        },
        // Tenant-scoped read: GLOBAL rows plus this team's and org's own.
        // Unfiltered, this leaked every custom skill's promptText to any team.
        where: skillVisibilityWhere({ orgId: team?.orgId, teamId }),
      });
      return { data: skills };
    }
  );
};
