import type { Prisma, Role } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import { roleMeets } from '@auto-swe/shared/config/permissions';
import { egressAllowlistSchema } from '@auto-swe/shared/lib/egressPolicy';
import { DOCKER_IMAGE_REF_RE } from '@auto-swe/shared/workflow';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendConflict } from '../lib/conflict.js';
import { loadEgressReadiness } from '../lib/egressReadiness.js';
import { sendError } from '../lib/httpErrors.js';
import { inviteUser } from '../lib/inviteUser.js';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { booleanQueryParam } from '../lib/queryParams.js';
import {
  memberTeams,
  permissionRequirement,
  repositoryManagementTeams,
} from '../lib/tenantScope.js';
import { type JwtPayload, requireAuth, requireUser } from '../plugins/auth.js';
import { teamScopedConfigRoutes } from './modelConfig.js';

/// Auditable subset of a team row.
function teamAuditFields(team: {
  description: string;
  id: string;
  isActive: boolean;
  name: string;
  orgId: string | null;
  slug: string;
}) {
  return {
    description: team.description,
    id: team.id,
    isActive: team.isActive,
    name: team.name,
    orgId: team.orgId,
    slug: team.slug,
  };
}

function membershipAuditFields(row: { role: string; teamId: string; userId: string }) {
  return { role: row.role, teamId: row.teamId, userId: row.userId };
}

const CreateTeamSchema = z.object({
  adminUserId: z.string().uuid().optional(),
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

class OrganizationMemberRequired extends Error {}

async function ensureOrganizationMember(
  fastify: FastifyInstance,
  tx: Prisma.TransactionClient,
  actor: JwtPayload,
  orgId: string,
  userId: string,
  allowCreate: boolean
) {
  const existing = await tx.organizationMembership.findUnique({
    where: { userId_orgId: { orgId, userId } },
  });
  if (existing) {
    return;
  }
  if (!allowCreate) {
    throw new OrganizationMemberRequired();
  }
  const rows = await tx.organizationMembership.createMany({
    data: { orgId, role: 'ORG_MEMBER', userId },
    skipDuplicates: true,
  });
  if (rows.count) {
    const membership = await tx.organizationMembership.findUniqueOrThrow({
      where: { userId_orgId: { orgId, userId } },
    });
    await writeAuditLog(fastify, {
      action: 'CREATE',
      actor,
      after: { orgId, role: 'ORG_MEMBER', userId },
      client: tx,
      entityId: membership.id,
      entityType: 'OrganizationMembership',
    });
  }
}

async function createTeam(
  fastify: FastifyInstance,
  actor: JwtPayload,
  body: z.infer<typeof CreateTeamSchema>,
  orgId: string
) {
  return fastify.prisma.$transaction(async (tx) => {
    await ensureOrganizationMember(
      fastify,
      tx,
      actor,
      orgId,
      body.adminUserId ?? actor.sub,
      actor.role === 'ADMIN' && !body.adminUserId
    );
    const team = await tx.team.create({
      data: { description: body.description, name: body.name, orgId, slug: body.slug },
    });
    const membership = await tx.teamMembership.create({
      data: { role: 'ADMIN', teamId: team.id, userId: body.adminUserId ?? actor.sub },
    });
    await writeAuditLog(fastify, {
      action: 'CREATE',
      actor,
      after: teamAuditFields(team),
      client: tx,
      entityId: team.id,
      entityType: 'Team',
    });
    await writeAuditLog(fastify, {
      action: 'CREATE',
      actor,
      after: membershipAuditFields(membership),
      client: tx,
      entityId: membership.id,
      entityType: 'TeamMembership',
    });
    return team;
  });
}

export const orgTeamRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/:orgId/teams',
    {
      onRequest: requireAuth({ orgIdParam: 'orgId', requiredOrgRole: 'ORG_ADMIN' }),
      schema: {
        body: CreateTeamSchema.omit({ orgId: true }),
        params: z.object({ orgId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const org = await fastify.prisma.organization.findUnique({
        where: { id: request.params.orgId },
      });
      if (!org) {
        return sendError(reply, 400, 'ORG_NOT_FOUND', 'Organization not found');
      }
      try {
        const team = await createTeam(fastify, requireUser(request), request.body, org.id);
        return reply.status(201).send({ data: team });
      } catch (err) {
        if (err instanceof OrganizationMemberRequired) {
          return sendError(
            reply,
            400,
            'ORG_MEMBERSHIP_REQUIRED',
            'Team admin must be a member of the organization'
          );
        }
        if (isUniqueConstraintError(err)) {
          return sendConflict(reply, 'TEAM_EXISTS', 'Team name or slug already exists');
        }
        throw err;
      }
    }
  );
};

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
 * The team row lock serializes every membership write with launch-source checks.
 * Admin-removal counts also run under that lock to preserve the last-admin invariant.
 */
async function applyMembershipChange<T>(
  prisma: FastifyInstance['prisma'],
  teamId: string,
  removesAdmin: boolean,
  write: (db: Prisma.TransactionClient) => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; guard: TeamGuardResult }> {
  return prisma.$transaction(async (tx) => {
    // CLAUDE.md §7 exception: this lock is shared with source checks and serializes all
    // membership changes for this team.
    await tx.$executeRaw`SELECT 1 FROM teams WHERE id = ${teamId}::uuid FOR UPDATE`;
    if (removesAdmin) {
      const adminCount = await tx.teamMembership.count({ where: { role: 'ADMIN', teamId } });
      if (adminCount <= 1) {
        return { guard: LAST_TEAM_ADMIN, ok: false as const };
      }
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
      const { name, slug, orgId } = request.body;

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
        return sendError(
          reply,
          400,
          'ORG_NOT_FOUND',
          orgId ? `Organization ${orgId} not found` : 'No default organization exists'
        );
      }

      // The findFirst above is a friendly pre-check; the unique indexes on
      // name/slug are the real guard, so map their violation to the same 409.
      let team: Awaited<ReturnType<typeof fastify.prisma.team.create>>;
      try {
        team = await createTeam(fastify, requireUser(request), request.body, org.id);
      } catch (err) {
        if (err instanceof OrganizationMemberRequired) {
          return sendError(
            reply,
            400,
            'ORG_MEMBERSHIP_REQUIRED',
            'Team admin must be a member of the organization'
          );
        }
        if (isUniqueConstraintError(err)) {
          return sendConflict(reply, 'TEAM_EXISTS', 'Team name or slug already exists');
        }
        throw err;
      }

      return reply.status(201).send({ data: team });
    }
  );

  // GET /api/v1/teams — List teams. Each row carries the caller's own role in it (`myRole`,
  // null for a team they do not belong to, e.g. a platform ADMIN's view of every team) so the
  // dashboard needs no per-team detail request. `member=true` narrows to the caller's own
  // teams, even for a platform ADMIN.
  app.get(
    '/',
    {
      config: { mcpScope: 'read' },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: z.object({ member: booleanQueryParam() }) },
    },
    async (request) => {
      const user = requireUser(request);
      const memberOnly = user.role !== 'ADMIN' || request.query.member;
      // `memberTeams(user)` is a literal AND element so the tenant guard's static check sees the
      // membership predicate; `{}` (no restriction) is only reachable for a platform ADMIN.
      const where: Prisma.TeamWhereInput = {
        AND: [
          { isActive: true },
          memberOnly
            ? request.query.member
              ? memberTeams(user)
              : { OR: [memberTeams(user), repositoryManagementTeams(user)] }
            : {},
        ],
      };

      // Unscoped only for a platform admin who did not ask for `member=true`, which is the
      // deliberate cross-tenant branch.
      const rows = await asPlatformAdmin(user, 'admin lists every team', ['Team'], () =>
        fastify.prisma.team.findMany({
          include: {
            _count: { select: { memberships: true, repositories: true } },
            // Only the caller's own membership row: never another member's role.
            memberships: { select: { role: true }, where: { userId: user.sub } },
            organization: { select: { name: true } },
          },
          orderBy: { name: 'asc' },
          where,
        })
      );

      const teams = rows.map(({ memberships, organization, ...team }) => ({
        ...team,
        myRole: memberships[0]?.role ?? null,
        orgName: organization.name,
      }));

      return { data: teams };
    }
  );

  // GET /api/v1/teams/:id — Team detail
  app.get(
    '/:id',
    {
      config: { mcpScope: 'read' },
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
        return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
      }

      // Non-admins may only view teams they belong to
      if (user.role !== 'ADMIN') {
        const isMember = team.memberships.some((m) => m.user.id === user.sub);
        if (!isMember) {
          return sendError(reply, 403, 'FORBIDDEN', 'You are not a member of this team');
        }
      }

      // Repositories other teams have shared with this one: read-only here,
      // and listed under the same visibility the Connections page applies —
      // active rows only, and under an enforcing repo-access gate only those
      // the caller's own GitHub permission reaches. A platform ADMIN is not
      // gated, as everywhere else.
      const shares = await fastify.prisma.connectionTeamShare.findMany({
        select: {
          canLaunch: true,
          connection: {
            select: {
              id: true,
              isActive: true,
              organizationName: true,
              repoName: true,
              team: { select: { id: true, name: true, slug: true } },
            },
          },
        },
        where: {
          connection: {
            isActive: true,
            type: 'git_repo',
            ...(user.role === 'ADMIN' ? {} : permissionRequirement(user, request.repoAccessGate)),
          },
          teamId: team.id,
        },
      });
      // `canLaunch` is this team's own share: false means the team may view the repository only.
      const sharedRepositories = shares
        .map((s) => ({ ...s.connection, canLaunch: s.canLaunch }))
        .sort((a, b) =>
          `${a.organizationName}/${a.repoName}`.localeCompare(`${b.organizationName}/${b.repoName}`)
        );

      return { data: { ...team, sharedRepositories } };
    }
  );

  // PATCH /api/v1/teams/:id — Update team (requires LEAD in this team)
  app.patch(
    '/:id',
    {
      onRequest: requireAuth({ requiredTeamRole: 'LEAD', teamIdParam: 'id' }),
      schema: { body: UpdateTeamSchema, params: TeamParamsSchema },
    },
    async (request, reply) => {
      const team = await fastify.prisma.team.findUnique({
        where: { id: request.params.id },
      });
      if (!team) {
        return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
      }

      // A rename onto another team's name trips the unique index on name.
      let updated: Awaited<ReturnType<typeof fastify.prisma.team.update>>;
      try {
        updated = await fastify.prisma.team.update({
          data: request.body,
          where: { id: request.params.id },
        });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return sendConflict(reply, 'TEAM_EXISTS', 'Team name already exists');
        }
        throw err;
      }

      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: requireUser(request),
        after: teamAuditFields(updated),
        before: teamAuditFields(team),
        entityId: team.id,
        entityType: 'Team',
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
        return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
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
        select: { id: true, shellImageAllowlist: true },
        where: { id: request.params.id },
      });
      if (!exists) {
        return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
      }
      const updated = await fastify.prisma.team.update({
        data: { shellImageAllowlist: request.body.shellImageAllowlist },
        select: { shellImageAllowlist: true },
        where: { id: request.params.id },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: requireUser(request),
        after: { shellImageAllowlist: updated.shellImageAllowlist },
        before: { shellImageAllowlist: exists.shellImageAllowlist },
        entityId: exists.id,
        entityType: 'Team',
      });
      return { data: { shellImageAllowlist: updated.shellImageAllowlist } };
    }
  );

  // ── Phase-9: per-team egress allowlist ──────────────────────────────────
  const EgressAllowlistBody = z.object({
    egressAllowlist: egressAllowlistSchema,
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
        select: { egressAllowlist: true, orgId: true },
        where: { id: request.params.id },
      });
      if (!team) {
        return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
      }
      const baselineAllowlist = await resolveSetting('workspace.egressBaselineAllowlist', {
        orgId: team.orgId ?? undefined,
      });
      return { data: { baselineAllowlist, egressAllowlist: team.egressAllowlist } };
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
        select: { egressAllowlist: true, id: true },
        where: { id: request.params.id },
      });
      if (!exists) {
        return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
      }
      const updated = await fastify.prisma.team.update({
        data: { egressAllowlist: request.body.egressAllowlist },
        select: { egressAllowlist: true },
        where: { id: request.params.id },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: requireUser(request),
        after: { egressAllowlist: updated.egressAllowlist },
        before: { egressAllowlist: exists.egressAllowlist },
        entityId: exists.id,
        entityType: 'Team',
      });
      const { warnings } = await loadEgressReadiness(fastify.prisma, undefined, {
        allowlist: updated.egressAllowlist,
        id: request.params.id,
      });
      return {
        data: { egressAllowlist: updated.egressAllowlist },
        ...(warnings.length ? { warnings } : {}),
      };
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
        return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
      }

      await fastify.prisma.$transaction(async (tx) => {
        // CLAUDE.md §7 exception: serialize team deactivation with source checks.
        await tx.$executeRaw`SELECT 1 FROM teams WHERE id = ${request.params.id}::uuid FOR UPDATE`;
        await tx.team.update({
          data: { isActive: false },
          where: { id: request.params.id },
        });
        // The entry commits with the change it records: an audit failure must not leave a
        // deactivated team with no record of who deactivated it.
        await writeAuditLog(fastify, {
          action: 'DELETE',
          actor: requireUser(request),
          after: { isActive: false },
          before: teamAuditFields(team),
          client: tx,
          entityId: team.id,
          entityType: 'Team',
        });
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

  app.post(
    '/:id/members/invite',
    {
      onRequest: requireAuth({ requiredTeamRole: 'LEAD', teamIdParam: 'id' }),
      schema: {
        body: z.object({
          email: z.string().trim().toLowerCase().email(),
          role: z.enum(['ADMIN', 'LEAD', 'ENGINEER']).default('ENGINEER'),
        }),
        params: TeamParamsSchema,
      },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const actorRole = (request.teamRole as Role | undefined) ?? actor.role;
      if (roleMeets(request.body.role, actorRole) && request.body.role !== actorRole) {
        return sendError(
          reply,
          403,
          'PRIVILEGE_ESCALATION',
          'Cannot grant a role higher than your own'
        );
      }
      const team = await fastify.prisma.team.findUnique({ where: { id: request.params.id } });
      if (!team) {
        return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
      }
      const result = await inviteUser(fastify, actor, {
        email: request.body.email,
        orgId: team.orgId,
        orgRole: 'ORG_MEMBER',
        source: 'team_lead',
        teamId: team.id,
        teamRole: request.body.role,
      });
      if (!result.ok) {
        return sendError(reply, result.status, result.code, result.message);
      }
      return reply.status(201).send({ data: { ...result.user, teamRole: request.body.role } });
    }
  );

  app.post(
    '/:id/members',
    {
      onRequest: requireAuth({ requiredTeamRole: 'LEAD', teamIdParam: 'id' }),
      schema: { body: AddMemberSchema, params: TeamParamsSchema },
    },
    async (request, reply) => {
      const { userId, role } = request.body;
      const actorRole = (request.teamRole as Role | undefined) ?? requireUser(request).role;

      if (roleMeets(role, actorRole) && role !== actorRole) {
        return sendError(
          reply,
          403,
          'PRIVILEGE_ESCALATION',
          'Cannot grant a role higher than your own'
        );
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
        const result = await applyMembershipChange(
          fastify.prisma,
          request.params.id,
          false,
          async (db) => {
            const team = await db.team.findUniqueOrThrow({ where: { id: request.params.id } });
            await ensureOrganizationMember(
              fastify,
              db,
              requireUser(request),
              team.orgId,
              userId,
              requireUser(request).role === 'ADMIN'
            );
            const membership = await db.teamMembership.create({
              data: {
                role,
                teamId: request.params.id,
                userId,
              },
              include: { user: { select: { email: true, id: true, role: true } } },
            });
            await writeAuditLog(fastify, {
              action: 'CREATE',
              actor: requireUser(request),
              after: membershipAuditFields(membership),
              client: db,
              entityId: membership.id,
              entityType: 'TeamMembership',
            });
            return membership;
          }
        );
        if (!result.ok) {
          return sendError(reply, 409, result.guard.code, result.guard.message);
        }
        return reply.status(201).send({ data: result.value });
      } catch (err) {
        if (err instanceof OrganizationMemberRequired) {
          return sendError(
            reply,
            400,
            'ORG_MEMBERSHIP_REQUIRED',
            'User must be a member of the team organization'
          );
        }
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
      onRequest: requireAuth({ requiredTeamRole: 'LEAD', teamIdParam: 'id' }),
      schema: { body: UpdateMemberSchema, params: TeamMemberParamsSchema },
    },
    async (request, reply) => {
      const actorRole = (request.teamRole as Role | undefined) ?? requireUser(request).role;
      const membership = await fastify.prisma.teamMembership.findUnique({
        where: { userId_teamId: { teamId: request.params.id, userId: request.params.userId } },
      });
      if (!membership) {
        return sendError(reply, 404, 'MEMBER_NOT_FOUND', 'Membership not found');
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
        return sendError(reply, 409, guard.code, guard.message);
      }

      const result = await applyMembershipChange(
        fastify.prisma,
        request.params.id,
        removesTeamAdmin(membership.role, 'update', request.body.role),
        async (db) => {
          const updated = await db.teamMembership.update({
            data: { role: request.body.role },
            where: { id: membership.id },
          });
          await writeAuditLog(fastify, {
            action: 'UPDATE',
            actor: requireUser(request),
            after: membershipAuditFields(updated),
            before: membershipAuditFields(membership),
            client: db,
            entityId: membership.id,
            entityType: 'TeamMembership',
          });
          return updated;
        }
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
      onRequest: requireAuth({ requiredTeamRole: 'LEAD', teamIdParam: 'id' }),
      schema: { params: TeamMemberParamsSchema },
    },
    async (request, reply) => {
      const actorRole = (request.teamRole as Role | undefined) ?? requireUser(request).role;
      const membership = await fastify.prisma.teamMembership.findUnique({
        where: { userId_teamId: { teamId: request.params.id, userId: request.params.userId } },
      });
      if (!membership) {
        return sendError(reply, 404, 'MEMBER_NOT_FOUND', 'Membership not found');
      }

      const guard = guardTeamMembershipChange(
        requireUser(request).sub,
        actorRole,
        request.params.userId,
        membership.role,
        'delete'
      );
      if (guard) {
        return sendError(reply, 409, guard.code, guard.message);
      }

      const result = await applyMembershipChange(
        fastify.prisma,
        request.params.id,
        removesTeamAdmin(membership.role, 'delete'),
        async (db) => {
          const removed = await db.teamMembership.delete({ where: { id: membership.id } });
          await writeAuditLog(fastify, {
            action: 'DELETE',
            actor: requireUser(request),
            before: membershipAuditFields(membership),
            client: db,
            entityId: membership.id,
            entityType: 'TeamMembership',
          });
          return removed;
        }
      );
      if (!result.ok) {
        return sendError(reply, 409, result.guard.code, result.guard.message);
      }

      return { data: { removed: true } };
    }
  );
};
