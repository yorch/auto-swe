import type { Prisma, Role } from '@auto-swe/shared';
import { roleMeets } from '@auto-swe/shared/config/permissions';
import { DOCKER_IMAGE_REF_RE } from '@auto-swe/shared/workflow';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sendConflict } from '../lib/conflict.js';
import { sendError } from '../lib/httpErrors.js';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { memberTeams } from '../lib/tenantScope.js';
import { requireAuth, requireUser } from '../plugins/auth.js';
import { teamScopedConfigRoutes } from './modelConfig.js';

const CreateTeamSchema = z.object({
  description: z.string().max(500).default(''),
  name: z.string().min(1).max(100),
  /** P5: owning organization. Defaults to the 'default' org when omitted. */
  orgId: z.string().uuid().optional(),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase-kebab-case'),
});

const UpdateTeamSchema = z.object({
  defaultPersonaPrompt: z.string().max(2000).nullable().optional(),
  description: z.string().max(500).optional(),
  name: z.string().min(1).max(100).optional(),
});

const TeamParamsSchema = z.object({ id: z.string().uuid() });
const TeamMemberParamsSchema = z.object({ id: z.string().uuid(), userId: z.string().uuid() });

const AddMemberSchema = z.object({
  role: z.enum(['ADMIN', 'LEAD', 'ENGINEER']).default('ENGINEER'),
  userId: z.string().uuid(),
});

const UpdateMemberSchema = z.object({
  role: z.enum(['ADMIN', 'LEAD', 'ENGINEER']),
});

interface TeamGuardResult {
  code: string;
  message: string;
}

/**
 * Prevent self-removal/self-demotion and hierarchy violations. Removing the last
 * team admin is refused inside the write — see `applyMembershipChange`.
 */
function guardTeamMembershipChange(
  actorUserId: string,
  actorRole: Role,
  targetUserId: string,
  targetRole: Role,
  action: 'delete' | 'update',
  newRole?: Role
): TeamGuardResult | null {
  if (actorUserId === targetUserId) {
    if (action === 'delete') {
      return { code: 'SELF_REMOVAL', message: 'Cannot remove yourself from the team' };
    }
    if (newRole && newRole !== actorRole) {
      return { code: 'SELF_DEMOTION', message: 'Cannot demote yourself' };
    }
  }
  if (roleMeets(targetRole, actorRole) && targetRole !== actorRole) {
    return { code: 'HIERARCHY', message: 'Cannot modify a member with a higher role' };
  }
  if (newRole && roleMeets(newRole, actorRole) && newRole !== actorRole) {
    return { code: 'PRIVILEGE_ESCALATION', message: 'Cannot grant a role higher than your own' };
  }
  return null;
}

const LAST_TEAM_ADMIN: TeamGuardResult = {
  code: 'LAST_TEAM_ADMIN',
  message: 'Cannot remove or demote the last team admin',
};

/** Does this change take an ADMIN away from the team? */
function removesTeamAdmin(targetRole: Role, action: 'delete' | 'update', newRole?: Role): boolean {
  return targetRole === 'ADMIN' && (action === 'delete' || (!!newRole && newRole !== 'ADMIN'));
}

/**
 * Apply a membership change, refusing it when it would leave the team with no
 * ADMIN.
 *
 * Count-then-write on its own is a race: two admins demoting each other both
 * count two admins, both proceed, and the team ends with none. The team row is
 * locked for the transaction, so concurrent admin removals on one team queue
 * behind each other and each counts what the previous one committed. Only
 * changes that remove an admin take the lock; everything else writes directly.
 */
async function applyMembershipChange<T>(
  prisma: FastifyInstance['prisma'],
  teamId: string,
  removesAdmin: boolean,
  write: (db: Prisma.TransactionClient) => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; guard: TeamGuardResult }> {
  if (!removesAdmin) {
    return { ok: true, value: await write(prisma) };
  }
  return prisma.$transaction(async (tx) => {
    // CLAUDE.md §7 exception: a row lock on the team serialises concurrent
    // admin removals; Prisma has no `SELECT … FOR UPDATE`.
    await tx.$executeRaw`SELECT 1 FROM teams WHERE id = ${teamId}::uuid FOR UPDATE`;
    const adminCount = await tx.teamMembership.count({ where: { role: 'ADMIN', teamId } });
    if (adminCount <= 1) {
      return { guard: LAST_TEAM_ADMIN, ok: false as const };
    }
    return { ok: true as const, value: await write(tx) };
  });
}

export const teamRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Phase 3 model-config team-scoped routes (added under the same /api/v1/teams
  // prefix as the rest of this plugin). Defined in modelConfig.ts so admin and
  // team-scope variants share helpers and audit-log writers.
  await fastify.register(teamScopedConfigRoutes);

  // POST /api/v1/teams — Create team (ADMIN only)
  app.post(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { body: CreateTeamSchema },
    },
    async (request, reply) => {
      const { name, slug, description, orgId } = request.body;

      const existing = await fastify.prisma.team.findFirst({
        where: { OR: [{ name }, { slug }] },
      });
      if (existing) {
        return sendConflict(reply, 'TEAM_EXISTS', 'Team name or slug already exists');
      }

      // P5: every team nests under an organization. Use the requested org, else
      // fall back to the seeded 'default' org so single-tenant flows still work.
      const org = orgId
        ? await fastify.prisma.organization.findUnique({ where: { id: orgId } })
        : await fastify.prisma.organization.findUnique({ where: { slug: 'default' } });
      if (!org) {
        return reply.status(400).send({
          error: {
            code: 'ORG_NOT_FOUND',
            message: orgId ? `Organization ${orgId} not found` : 'No default organization exists',
          },
        });
      }

      // The findFirst above is a friendly pre-check; the unique indexes on
      // name/slug are the real guard, so map their violation to the same 409.
      let team: Awaited<ReturnType<typeof fastify.prisma.team.create>>;
      try {
        team = await fastify.prisma.team.create({
          data: { description, name, orgId: org.id, slug },
        });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return sendConflict(reply, 'TEAM_EXISTS', 'Team name or slug already exists');
        }
        throw err;
      }

      return reply.status(201).send({ data: team });
    }
  );

  // GET /api/v1/teams — List teams
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
    },
    async (request) => {
      const user = requireUser(request);
      const where: Prisma.TeamWhereInput = {
        isActive: true,
        ...(user.role !== 'ADMIN' && {
          ...memberTeams(user),
        }),
      };

      // The spread above is `{}` for a platform admin, which is the deliberate
      // cross-tenant branch.
      const teams = await asPlatformAdmin(user, 'admin lists every team', ['Team'], () =>
        fastify.prisma.team.findMany({
          include: {
            _count: { select: { memberships: true, repositories: true } },
          },
          orderBy: { name: 'asc' },
          where,
        })
      );

      return { data: teams };
    }
  );

  // GET /api/v1/teams/:id — Team detail
  app.get(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: TeamParamsSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);

      const team = await fastify.prisma.team.findUnique({
        include: {
          memberships: { include: { user: { select: { email: true, id: true, role: true } } } },
          repositories: {
            select: { id: true, isActive: true, organizationName: true, repoName: true },
          },
        },
        where: { id: request.params.id },
      });

      if (!team) {
        return reply.status(404).send({
          error: { code: 'TEAM_NOT_FOUND', message: 'Team not found' },
        });
      }

      // Non-admins may only view teams they belong to
      if (user.role !== 'ADMIN') {
        const isMember = team.memberships.some((m) => m.user.id === user.sub);
        if (!isMember) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'You are not a member of this team' },
          });
        }
      }

      return { data: team };
    }
  );

  // PATCH /api/v1/teams/:id — Update team (requires LEAD in this team)
  app.patch(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD', requiredTeamRole: 'LEAD', teamIdParam: 'id' }),
      schema: { body: UpdateTeamSchema, params: TeamParamsSchema },
    },
    async (request, reply) => {
      const team = await fastify.prisma.team.findUnique({
        where: { id: request.params.id },
      });
      if (!team) {
        return reply.status(404).send({
          error: { code: 'TEAM_NOT_FOUND', message: 'Team not found' },
        });
      }

      const updated = await fastify.prisma.team.update({
        data: request.body,
        where: { id: request.params.id },
      });

      return { data: updated };
    }
  );

  // ── Phase 6: shell-step image allowlist ─────────────────────────────────
  // Restricted to team ADMINs (role hierarchy treats platform ADMIN as ≥ team
  // ADMIN, so platform admins can also edit). Built-in images are always
  // allowed; this list only adds to them.
  const ShellAllowlistBody = z.object({
    shellImageAllowlist: z
      .array(
        z
          .string()
          .min(1)
          .max(256)
          .regex(
            DOCKER_IMAGE_REF_RE,
            'image must look like registry/org/name:tag — no whitespace or shell metacharacters'
          )
      )
      .max(50),
  });

  app.get(
    '/:id/shell-image-allowlist',
    {
      onRequest: requireAuth({
        requiredRole: 'ENGINEER',
        requiredTeamRole: 'ENGINEER',
        teamIdParam: 'id',
      }),
      schema: { params: TeamParamsSchema },
    },
    async (request, reply) => {
      const team = await fastify.prisma.team.findUnique({
        select: { shellImageAllowlist: true },
        where: { id: request.params.id },
      });
      if (!team) {
        return reply
          .status(404)
          .send({ error: { code: 'TEAM_NOT_FOUND', message: 'Team not found' } });
      }
      return { data: { shellImageAllowlist: team.shellImageAllowlist } };
    }
  );

  app.put(
    '/:id/shell-image-allowlist',
    {
      onRequest: requireAuth({
        requiredRole: 'ADMIN',
        requiredTeamRole: 'ADMIN',
        teamIdParam: 'id',
      }),
      schema: { body: ShellAllowlistBody, params: TeamParamsSchema },
    },
    async (request, reply) => {
      const exists = await fastify.prisma.team.findUnique({
        select: { id: true },
        where: { id: request.params.id },
      });
      if (!exists) {
        return reply
          .status(404)
          .send({ error: { code: 'TEAM_NOT_FOUND', message: 'Team not found' } });
      }
      const updated = await fastify.prisma.team.update({
        data: { shellImageAllowlist: request.body.shellImageAllowlist },
        select: { shellImageAllowlist: true },
        where: { id: request.params.id },
      });
      return { data: { shellImageAllowlist: updated.shellImageAllowlist } };
    }
  );

  // ── Phase-9: per-team egress allowlist ──────────────────────────────────
  const HOSTNAME_RE =
    /^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  const EgressAllowlistBody = z.object({
    egressAllowlist: z
      .array(
        z
          .string()
          .min(1)
          .max(256)
          .regex(
            HOSTNAME_RE,
            'must be a valid hostname or wildcard hostname (e.g. registry.npmjs.org or *.github.com)'
          )
      )
      .max(100),
  });

  app.get(
    '/:id/egress-allowlist',
    {
      onRequest: requireAuth({
        requiredRole: 'ENGINEER',
        requiredTeamRole: 'ENGINEER',
        teamIdParam: 'id',
      }),
      schema: { params: TeamParamsSchema },
    },
    async (request, reply) => {
      const team = await fastify.prisma.team.findUnique({
        select: { egressAllowlist: true },
        where: { id: request.params.id },
      });
      if (!team) {
        return reply
          .status(404)
          .send({ error: { code: 'TEAM_NOT_FOUND', message: 'Team not found' } });
      }
      return { data: { egressAllowlist: team.egressAllowlist } };
    }
  );

  app.put(
    '/:id/egress-allowlist',
    {
      onRequest: requireAuth({
        requiredRole: 'ADMIN',
        requiredTeamRole: 'ADMIN',
        teamIdParam: 'id',
      }),
      schema: { body: EgressAllowlistBody, params: TeamParamsSchema },
    },
    async (request, reply) => {
      const exists = await fastify.prisma.team.findUnique({
        select: { id: true },
        where: { id: request.params.id },
      });
      if (!exists) {
        return reply
          .status(404)
          .send({ error: { code: 'TEAM_NOT_FOUND', message: 'Team not found' } });
      }
      const updated = await fastify.prisma.team.update({
        data: { egressAllowlist: request.body.egressAllowlist },
        select: { egressAllowlist: true },
        where: { id: request.params.id },
      });
      return { data: { egressAllowlist: updated.egressAllowlist } };
    }
  );

  // DELETE /api/v1/teams/:id — Soft-delete team (ADMIN only)
  app.delete(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { params: TeamParamsSchema },
    },
    async (request, reply) => {
      const team = await fastify.prisma.team.findUnique({
        where: { id: request.params.id },
      });
      if (!team) {
        return reply.status(404).send({
          error: { code: 'TEAM_NOT_FOUND', message: 'Team not found' },
        });
      }

      await fastify.prisma.team.update({
        data: { isActive: false },
        where: { id: request.params.id },
      });

      return { data: { deleted: true } };
    }
  );

  // ── Team Members ──

  // GET /api/v1/teams/:id/members
  app.get<{ Params: { id: string } }>(
    '/:id/members',
    {
      onRequest: requireAuth({ requiredTeamRole: 'ENGINEER', teamIdParam: 'id' }),
    },
    async (request) => {
      const members = await fastify.prisma.teamMembership.findMany({
        include: {
          user: { select: { email: true, id: true, isActive: true, role: true, slackId: true } },
        },
        orderBy: { createdAt: 'asc' },
        where: { teamId: request.params.id },
      });

      return { data: members };
    }
  );

  // POST /api/v1/teams/:id/members — Add member (requires LEAD in this team)
  app.post(
    '/:id/members',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD', requiredTeamRole: 'LEAD', teamIdParam: 'id' }),
      schema: { body: AddMemberSchema, params: TeamParamsSchema },
    },
    async (request, reply) => {
      const { userId, role } = request.body;
      const actorRole = (request.teamRole as Role | undefined) ?? requireUser(request).role;

      if (roleMeets(role, actorRole) && role !== actorRole) {
        return reply.status(403).send({
          error: {
            code: 'PRIVILEGE_ESCALATION',
            message: 'Cannot grant a role higher than your own',
          },
        });
      }

      const existing = await fastify.prisma.teamMembership.findUnique({
        where: { userId_teamId: { teamId: request.params.id, userId } },
      });
      if (existing) {
        return sendConflict(reply, 'MEMBER_EXISTS', 'User is already a member of this team');
      }

      // The read above is only the friendly early answer; the unique index on
      // (userId, teamId) decides a concurrent double-add, which must be a 409,
      // not a 500.
      try {
        const membership = await fastify.prisma.teamMembership.create({
          data: {
            role,
            teamId: request.params.id,
            userId,
          },
          include: { user: { select: { email: true, id: true, role: true } } },
        });
        return reply.status(201).send({ data: membership });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return sendConflict(reply, 'MEMBER_EXISTS', 'User is already a member of this team');
        }
        throw err;
      }
    }
  );

  // PATCH /api/v1/teams/:id/members/:userId — Update member role (requires LEAD in this team)
  app.patch(
    '/:id/members/:userId',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD', requiredTeamRole: 'LEAD', teamIdParam: 'id' }),
      schema: { body: UpdateMemberSchema, params: TeamMemberParamsSchema },
    },
    async (request, reply) => {
      const actorRole = (request.teamRole as Role | undefined) ?? requireUser(request).role;
      const membership = await fastify.prisma.teamMembership.findUnique({
        where: { userId_teamId: { teamId: request.params.id, userId: request.params.userId } },
      });
      if (!membership) {
        return reply.status(404).send({
          error: { code: 'MEMBER_NOT_FOUND', message: 'Membership not found' },
        });
      }

      const guard = guardTeamMembershipChange(
        requireUser(request).sub,
        actorRole,
        request.params.userId,
        membership.role,
        'update',
        request.body.role
      );
      if (guard) {
        return reply.status(409).send({ error: { code: guard.code, message: guard.message } });
      }

      const result = await applyMembershipChange(
        fastify.prisma,
        request.params.id,
        removesTeamAdmin(membership.role, 'update', request.body.role),
        (db) =>
          db.teamMembership.update({
            data: { role: request.body.role },
            where: { id: membership.id },
          })
      );
      if (!result.ok) {
        return sendError(reply, 409, result.guard.code, result.guard.message);
      }

      return { data: result.value };
    }
  );

  // DELETE /api/v1/teams/:id/members/:userId — Remove member (requires LEAD in this team)
  app.delete(
    '/:id/members/:userId',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD', requiredTeamRole: 'LEAD', teamIdParam: 'id' }),
      schema: { params: TeamMemberParamsSchema },
    },
    async (request, reply) => {
      const actorRole = (request.teamRole as Role | undefined) ?? requireUser(request).role;
      const membership = await fastify.prisma.teamMembership.findUnique({
        where: { userId_teamId: { teamId: request.params.id, userId: request.params.userId } },
      });
      if (!membership) {
        return reply.status(404).send({
          error: { code: 'MEMBER_NOT_FOUND', message: 'Membership not found' },
        });
      }

      const guard = guardTeamMembershipChange(
        requireUser(request).sub,
        actorRole,
        request.params.userId,
        membership.role,
        'delete'
      );
      if (guard) {
        return reply.status(409).send({ error: { code: guard.code, message: guard.message } });
      }

      const result = await applyMembershipChange(
        fastify.prisma,
        request.params.id,
        removesTeamAdmin(membership.role, 'delete'),
        (db) => db.teamMembership.delete({ where: { id: membership.id } })
      );
      if (!result.ok) {
        return sendError(reply, 409, result.guard.code, result.guard.message);
      }

      return { data: { removed: true } };
    }
  );
};
