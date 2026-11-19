import type { Prisma } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import { egressAllowlistSchema } from '@auto-swe/shared/lib/egressPolicy';
import {
  actingRank,
  isPlatformAdmin,
  loadStanding,
  notSelf,
  TEAM_ROLE_RANK,
  type TeamRank,
  teamRankMeets,
  teamRankOf,
} from '@auto-swe/shared/permissions';
import { DOCKER_IMAGE_REF_RE } from '@auto-swe/shared/workflow';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type AuditContext, auditContextOf } from '../lib/auditContext.js';
import { writeAuditLog } from '../lib/auditLog.js';
import { actorOf, can, replyRefusal } from '../lib/authz.js';
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
  allowCreate: boolean,
  context?: AuditContext
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
      ...(context ? { context } : {}),
      entityId: membership.id,
      entityType: 'OrganizationMembership',
    });
  }
}

async function createTeam(
  fastify: FastifyInstance,
  actor: JwtPayload,
  body: z.infer<typeof CreateTeamSchema>,
  orgId: string,
  context?: AuditContext
) {
  const audit = context ? { context } : {};
  return fastify.prisma.$transaction(async (tx) => {
    // CLAUDE.md §7 exception: the organization lock serializes the first admin's membership checks
    // with an organization removal, which deletes team memberships under the same lock.
    await tx.$executeRaw`SELECT 1 FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`;
    await ensureOrganizationMember(
      fastify,
      tx,
      actor,
      orgId,
      body.adminUserId ?? actor.sub,
      isPlatformAdmin(actor) && !body.adminUserId,
      context
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
      ...audit,
      entityId: team.id,
      entityType: 'Team',
    });
    await writeAuditLog(fastify, {
      action: 'CREATE',
      actor,
      after: membershipAuditFields(membership),
      client: tx,
      ...audit,
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
      onRequest: requireAuth({ capability: 'org.teams.create', org: { param: 'orgId' } }),
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

/** A stored membership role as a rank. An unknown value ranks lowest: it confers nothing. */
function rankOf(role: string): TeamRank {
  return teamRankOf(role) ?? 'MEMBER';
}

/** Whether `rank` is above `ceiling`. */
function outranks(rank: TeamRank, ceiling: TeamRank): boolean {
  return TEAM_ROLE_RANK[rank] > TEAM_ROLE_RANK[ceiling];
}

/**
 * The rank the caller acts at in `teamId` for a member change: platform and organization
 * authority without a membership rank `ADMIN`, a membership ranks as its role (`actingRank`).
 * `null` means no standing at all, which a route that passed its capability check never sees.
 */
async function actingRankOf(request: FastifyRequest, teamId: string): Promise<TeamRank | null> {
  const standing = await loadStanding(request.server.prisma, actorOf(request), { teamId });
  return actingRank(standing, teamId);
}

/**
 * Prevent self-removal/self-demotion and hierarchy violations. Removing the last
 * team admin is refused inside the write — see `applyMembershipChange`.
 */
function guardTeamMembershipChange(
  actorUserId: string,
  actorRank: TeamRank,
  targetUserId: string,
  targetRole: string,
  action: 'delete' | 'update',
  newRole?: string
): TeamGuardResult | null {
  const targetRank = rankOf(targetRole);
  if (!notSelf(actorUserId, targetUserId)) {
    if (action === 'delete') {
      return { code: 'SELF_REMOVAL', message: 'Cannot remove yourself from the team' };
    }
    if (newRole && rankOf(newRole) !== targetRank) {
      return { code: 'SELF_DEMOTION', message: 'Cannot demote yourself' };
    }
  }
  if (outranks(targetRank, actorRank)) {
    return { code: 'HIERARCHY', message: 'Cannot modify a member with a higher role' };
  }
  if (newRole && outranks(rankOf(newRole), actorRank)) {
    return { code: 'PRIVILEGE_ESCALATION', message: 'Cannot grant a role higher than your own' };
  }
  return null;
}

const LAST_TEAM_ADMIN: TeamGuardResult = {
  code: 'LAST_TEAM_ADMIN',
  message: 'Cannot remove or demote the last team admin',
};

/** Does this change take an ADMIN away from the team? */
function removesTeamAdmin(
  targetRole: string,
  action: 'delete' | 'update',
  newRole?: string
): boolean {
  return (
    teamRankMeets(teamRankOf(targetRole), 'ADMIN') &&
    (action === 'delete' || (!!newRole && !teamRankMeets(teamRankOf(newRole), 'ADMIN')))
  );
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
  write: (db: Prisma.TransactionClient) => Promise<T>,
  /**
   * The team's organization, for a write that reads or creates an organization membership. Its row
   * lock is then taken first, before the team's, so the organization-removal cascade (which takes
   * the same two locks in the same order) cannot interleave with the add.
   */
  orgId?: string
): Promise<{ ok: true; value: T } | { ok: false; guard: TeamGuardResult }> {
  return prisma.$transaction(async (tx) => {
    if (orgId) {
      // CLAUDE.md §7 exception: the organization lock serializes this membership write with an
      // organization removal, which deletes the user's team memberships under the same lock.
      await tx.$executeRaw`SELECT 1 FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`;
    }
    // CLAUDE.md §7 exception: this lock is shared with source checks and serializes all
    // membership changes for this team.
    await tx.$executeRaw`SELECT 1 FROM teams WHERE id = ${teamId}::uuid FOR UPDATE`;
    if (removesAdmin) {
      const roles = await tx.teamMembership.findMany({ select: { role: true }, where: { teamId } });
      const adminCount = roles.filter((m) => teamRankMeets(teamRankOf(m.role), 'ADMIN')).length;
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

  // POST /api/v1/teams — Create team (`org.teams.create` on the target organization, the same
  // capability as the organization-scoped route)
  app.post(
    '/',
    {
      onRequest: requireAuth({ handlerChecked: ['org.teams.create'] }),
      schema: { body: CreateTeamSchema },
    },
    async (request, reply) => {
      const { name, slug, orgId } = request.body;

      // P5: every team nests under an organization. Use the requested org, else
      // fall back to the seeded 'default' org so single-tenant flows still work.
      const org = orgId
        ? await fastify.prisma.organization.findUnique({ where: { id: orgId } })
        : await fastify.prisma.organization.findUnique({ where: { slug: 'default' } });

      // The capability is decided before anything else is said about the team or the
      // organization, so a caller without it learns neither whether a name is taken nor
      // whether an organization exists.
      const decision = await can(
        request,
        'org.teams.create',
        org ? { orgId: org.id } : orgId ? { orgId } : undefined
      );
      if (!decision.allowed) {
        return replyRefusal(reply, decision);
      }
      const context = { ...auditContextOf(request), authority: decision.authority };

      const existing = await fastify.prisma.team.findFirst({
        where: { OR: [{ name }, { slug }] },
      });
      if (existing) {
        return sendConflict(reply, 'TEAM_EXISTS', 'Team name or slug already exists');
      }

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
        team = await createTeam(fastify, requireUser(request), request.body, org.id, context);
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
      onRequest: requireAuth(),
      schema: { querystring: z.object({ member: booleanQueryParam() }) },
    },
    async (request) => {
      const user = requireUser(request);
      const memberOnly = !isPlatformAdmin(user) || request.query.member;
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
      onRequest: requireAuth({ handlerChecked: ['team.read'] }),
      schema: { params: TeamParamsSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);

      const team = await fastify.prisma.team.findUnique({
        include: {
          memberships: {
            include: { user: { select: { email: true, id: true, isActive: true, role: true } } },
          },
          repositories: {
            select: { id: true, isActive: true, organizationName: true, repoName: true },
          },
        },
        where: { id: request.params.id },
      });

      if (!team) {
        return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
      }

      // Only a member of the team (or a platform administrator) may view it. The team is looked
      // up first so a missing one still answers 404, as it always has.
      const decision = await can(request, 'team.read', { teamId: team.id });
      if (!decision.allowed) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'You are not a member of this team',
            missing: decision.missing,
          },
        });
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
            ...(isPlatformAdmin(user) ? {} : permissionRequirement(user, request.repoAccessGate)),
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

  // PATCH /api/v1/teams/:id — Update team (`team.settings.manage`)
  app.patch(
    '/:id',
    {
      onRequest: requireAuth({ capability: 'team.settings.manage', team: { param: 'id' } }),
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
  // Reading is a team member's; writing is `team.sandbox-policy.manage`, which only a platform
  // administrator holds. Built-in images are always allowed; this list only adds to them.
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
      onRequest: requireAuth({ capability: 'team.sandbox-policy.read', team: { param: 'id' } }),
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
      onRequest: requireAuth({ capability: 'team.sandbox-policy.manage', team: { param: 'id' } }),
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
      onRequest: requireAuth({ capability: 'team.sandbox-policy.read', team: { param: 'id' } }),
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
      onRequest: requireAuth({ capability: 'team.sandbox-policy.manage', team: { param: 'id' } }),
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

  // DELETE /api/v1/teams/:id — Soft-delete team (`team.delete`, platform administrators only)
  app.delete(
    '/:id',
    {
      onRequest: requireAuth({ capability: 'team.delete', team: { param: 'id' } }),
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
      onRequest: requireAuth({ capability: 'team.members.read', team: { param: 'id' } }),
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
      onRequest: requireAuth({ capability: 'team.members.manage', team: { param: 'id' } }),
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
      const actorRank = await actingRankOf(request, request.params.id);
      if (!actorRank) {
        return sendError(reply, 403, 'FORBIDDEN', 'You have no standing in this team');
      }
      if (outranks(rankOf(request.body.role), actorRank)) {
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
        ...(request.authority ? { authority: request.authority } : {}),
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
      onRequest: requireAuth({ capability: 'team.members.manage', team: { param: 'id' } }),
      schema: { body: AddMemberSchema, params: TeamParamsSchema },
    },
    async (request, reply) => {
      const { userId, role } = request.body;
      const actorRank = await actingRankOf(request, request.params.id);
      if (!actorRank) {
        return sendError(reply, 403, 'FORBIDDEN', 'You have no standing in this team');
      }

      if (outranks(rankOf(role), actorRank)) {
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
      const target = await fastify.prisma.team.findUnique({
        select: { orgId: true },
        where: { id: request.params.id },
      });
      if (!target) {
        return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
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
              isPlatformAdmin(requireUser(request))
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
          },
          // The organization membership is read under the organization's lock, so an organization
          // removal that ran first is seen and one that runs next waits for this membership.
          target.orgId
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

  // PATCH /api/v1/teams/:id/members/:userId — Update member role (`team.members.manage`)
  app.patch(
    '/:id/members/:userId',
    {
      onRequest: requireAuth({ capability: 'team.members.manage', team: { param: 'id' } }),
      schema: { body: UpdateMemberSchema, params: TeamMemberParamsSchema },
    },
    async (request, reply) => {
      const actorRank = await actingRankOf(request, request.params.id);
      if (!actorRank) {
        return sendError(reply, 403, 'FORBIDDEN', 'You have no standing in this team');
      }
      const membership = await fastify.prisma.teamMembership.findUnique({
        where: { userId_teamId: { teamId: request.params.id, userId: request.params.userId } },
      });
      if (!membership) {
        return sendError(reply, 404, 'MEMBER_NOT_FOUND', 'Membership not found');
      }

      const guard = guardTeamMembershipChange(
        requireUser(request).sub,
        actorRank,
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

  // DELETE /api/v1/teams/:id/members/:userId — Remove member (`team.members.manage`)
  app.delete(
    '/:id/members/:userId',
    {
      onRequest: requireAuth({ capability: 'team.members.manage', team: { param: 'id' } }),
      schema: { params: TeamMemberParamsSchema },
    },
    async (request, reply) => {
      const actorRank = await actingRankOf(request, request.params.id);
      if (!actorRank) {
        return sendError(reply, 403, 'FORBIDDEN', 'You have no standing in this team');
      }
      const membership = await fastify.prisma.teamMembership.findUnique({
        where: { userId_teamId: { teamId: request.params.id, userId: request.params.userId } },
      });
      if (!membership) {
        return sendError(reply, 404, 'MEMBER_NOT_FOUND', 'Membership not found');
      }

      const guard = guardTeamMembershipChange(
        requireUser(request).sub,
        actorRank,
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
