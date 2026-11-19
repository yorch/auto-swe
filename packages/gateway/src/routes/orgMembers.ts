/**
 * Org membership CRUD (P5 RBAC).
 * Mounted at /api/v1/platform/organizations.
 *
 * Access is enforced declaratively by the `requireAuth` onRequest hook:
 * `org.members.read` to read, `org.members.manage` to write. The one exception is the invite,
 * which also needs `team.members.manage` on the team it names, so it asks both in the handler.
 */
import type { Prisma } from '@auto-swe/shared';
import {
  type Authority,
  actingRank,
  isPlatformAdmin,
  loadStanding,
  notSelf,
  orgIsAdmin,
  TEAM_ROLE_RANK,
  teamRankMeets,
  teamRankOf,
} from '@auto-swe/shared/permissions';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type AuditContext, auditContextOf } from '../lib/auditContext.js';
import { writeAuditLog } from '../lib/auditLog.js';
import { actorOf, can, replyRefusal } from '../lib/authz.js';
import { sendError } from '../lib/httpErrors.js';
import { inviteUser } from '../lib/inviteUser.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

function memberAuditFields(row: { orgId: string; role: string; userId: string }) {
  return { orgId: row.orgId, role: row.role, userId: row.userId };
}

const OrgParamsSchema = z.object({ orgId: z.string().uuid() });
const MemberParamsSchema = z.object({ orgId: z.string().uuid(), userId: z.string().uuid() });

const UpsertMemberSchema = z.object({
  role: z.enum(['ORG_ADMIN', 'ORG_MEMBER']).default('ORG_MEMBER'),
  userId: z.string().uuid(),
});

const PatchMemberSchema = z.object({
  role: z.enum(['ORG_ADMIN', 'ORG_MEMBER']),
});

type OrgMemberRole = z.infer<typeof PatchMemberSchema>['role'];

type OrgAdminGuardResult = { code: string; message: string } | null;

function teamMembershipAuditFields(row: { role: string; teamId: string; userId: string }) {
  return { role: row.role, teamId: row.teamId, userId: row.userId };
}

/** The more exceptional of two authorities, as a combined decision reports it. */
const AUTHORITY_ORDER: Readonly<Record<Authority, number>> = {
  'org-admin': 2,
  'org-member': 1,
  'platform-admin': 3,
  'team-role': 0,
};

function strongestAuthority(a: Authority, b: Authority): Authority {
  return AUTHORITY_ORDER[b] > AUTHORITY_ORDER[a] ? b : a;
}

/** Prevent self-demotion/self-removal and removing/demoting the last org admin. */
async function guardOrgAdminChange(
  db: Prisma.TransactionClient,
  orgId: string,
  targetUserId: string,
  actorUserId: string,
  action: 'delete' | 'update',
  currentRole: OrgMemberRole,
  newRole?: OrgMemberRole,
  actorIsPlatformAdmin = false
): Promise<OrgAdminGuardResult> {
  if (!notSelf(actorUserId, targetUserId)) {
    if (action === 'delete') {
      return { code: 'SELF_REMOVAL', message: 'Cannot remove yourself from the organization' };
    }
    if (newRole && newRole !== currentRole) {
      return { code: 'SELF_DEMOTION', message: 'Cannot change your own organization role' };
    }
  }
  // The instance operator may remove an organization's last admin (and then appoint another); the
  // organization's own admins may not leave it with none. A role change is not a removal.
  const operatorRemoval = action === 'delete' && actorIsPlatformAdmin;
  if (
    !operatorRemoval &&
    orgIsAdmin(currentRole) &&
    ((action === 'update' && newRole && !orgIsAdmin(newRole)) || action === 'delete')
  ) {
    const members = await db.organizationMembership.findMany({
      select: { role: true },
      where: { orgId },
    });
    const adminCount = members.filter((m) => orgIsAdmin(m.role)).length;
    if (adminCount <= 1) {
      return {
        code: 'LAST_ORG_ADMIN',
        message: 'Cannot remove or demote the last organization admin',
      };
    }
  }
  return null;
}

type CascadePlan =
  | { guard: { code: string; message: string } }
  | { rows: Array<{ id: string; role: string; teamId: string; userId: string }> };

/**
 * The user's memberships in every team of the organization, locked and checked, and nothing
 * written. The caller already holds the organization's row lock; the teams' locks are taken here in
 * ascending id order, the order every other writer takes them in. The memberships are read after the
 * locks, so a change that was waiting on one is seen.
 *
 * The cascade may leave a team with no ADMIN only for an actor who holds organization or platform
 * authority, who governs the team and can appoint another; for anyone else it is refused with the
 * `LAST_TEAM_ADMIN` a team-level removal gives. The team then shows `needsAdmin` on its overview.
 */
async function planTeamCascade(
  tx: Prisma.TransactionClient,
  orgId: string,
  userId: string,
  authority: Authority | undefined
): Promise<CascadePlan> {
  const teamIds = (
    await tx.teamMembership.findMany({
      orderBy: { teamId: 'asc' },
      select: { teamId: true },
      where: { team: { orgId }, userId },
    })
  ).map((m) => m.teamId);
  for (const teamId of [...teamIds].sort()) {
    // CLAUDE.md §7 exception: the team row lock every membership write takes, taken after the
    // organization's and in ascending id order so two cascades cannot deadlock.
    await tx.$executeRaw`SELECT 1 FROM teams WHERE id = ${teamId}::uuid FOR UPDATE`;
  }
  const rows = await tx.teamMembership.findMany({
    orderBy: { teamId: 'asc' },
    select: { id: true, role: true, teamId: true, userId: true },
    where: { team: { orgId }, userId },
  });
  const governs = authority === 'org-admin' || authority === 'platform-admin';
  const adminRows = rows.filter((r) => teamRankMeets(teamRankOf(r.role), 'ADMIN'));
  if (!governs && adminRows.length > 0) {
    const peers = await tx.teamMembership.findMany({
      select: { role: true, teamId: true, userId: true },
      where: { teamId: { in: adminRows.map((r) => r.teamId) } },
    });
    for (const row of adminRows) {
      const others = peers.filter(
        (p) =>
          p.teamId === row.teamId &&
          p.userId !== userId &&
          teamRankMeets(teamRankOf(p.role), 'ADMIN')
      );
      if (others.length === 0) {
        return {
          guard: {
            code: 'LAST_TEAM_ADMIN',
            message: 'Cannot remove or demote the last team admin',
          },
        };
      }
    }
  }
  return { rows };
}

async function removeTeamMemberships(
  fastify: Parameters<typeof orgMembersPlugin>[0],
  tx: Prisma.TransactionClient,
  request: FastifyRequest,
  rows: Extract<CascadePlan, { rows: unknown }>['rows']
): Promise<void> {
  for (const row of rows) {
    await tx.teamMembership.delete({ where: { id: row.id } });
    await writeAuditLog(fastify, {
      action: 'DELETE',
      actor: requireUser(request),
      before: teamMembershipAuditFields(row),
      client: tx,
      context: auditContextOf(request),
      entityId: row.id,
      entityType: 'TeamMembership',
    });
  }
}

async function withOrganizationMembershipLock<T>(
  fastify: Parameters<typeof orgMembersPlugin>[0],
  orgId: string,
  write: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return fastify.prisma.$transaction(async (tx) => {
    // CLAUDE.md §7 exception: serialize org membership writes with source checks and revocations.
    await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`;
    return write(tx);
  });
}

const orgMembersPlugin: FastifyPluginAsync = async (fastify) => {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/platform/organizations/:orgId/members
  f.get(
    '/:orgId/members',
    {
      onRequest: requireAuth({ capability: 'org.members.read', org: { param: 'orgId' } }),
      schema: { params: OrgParamsSchema },
    },
    async (request) => {
      const { orgId } = request.params;
      const rows = await fastify.prisma.organizationMembership.findMany({
        include: { user: { select: { email: true, id: true, name: true, role: true } } },
        orderBy: { createdAt: 'asc' },
        where: { orgId },
      });
      return {
        data: rows.map((r) => ({
          createdAt: r.createdAt,
          id: r.id,
          orgId: r.orgId,
          role: r.role,
          user: r.user,
          userId: r.userId,
        })),
      };
    }
  );

  // POST /api/v1/platform/organizations/:orgId/members
  f.post(
    '/:orgId/members',
    {
      onRequest: requireAuth({ capability: 'org.members.manage', org: { param: 'orgId' } }),
      schema: { body: UpsertMemberSchema, params: OrgParamsSchema },
    },
    async (request, reply) => {
      const { orgId } = request.params;
      const { userId, role } = request.body;

      const result = await withOrganizationMembershipLock(fastify, orgId, async (tx) => {
        const existing = await tx.organizationMembership.findUnique({
          where: { userId_orgId: { orgId, userId } },
        });
        if (existing) {
          const guard = await guardOrgAdminChange(
            tx,
            orgId,
            userId,
            requireUser(request).sub,
            'update',
            existing.role,
            role
          );
          if (guard) {
            return { guard };
          }
          const updated = await tx.organizationMembership.update({
            data: { role },
            where: { id: existing.id },
          });
          await writeAuditLog(fastify, {
            action: 'UPDATE',
            actor: requireUser(request),
            after: memberAuditFields(updated),
            before: memberAuditFields(existing),
            client: tx,
            entityId: existing.id,
            entityType: 'OrganizationMembership',
          });
          return { status: 200 as const, value: updated };
        }
        const created = await tx.organizationMembership.create({
          data: { orgId, role, userId },
        });
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor: requireUser(request),
          after: memberAuditFields(created),
          client: tx,
          entityId: created.id,
          entityType: 'OrganizationMembership',
        });
        return { status: 201 as const, value: created };
      });
      if ('guard' in result && result.guard) {
        return sendError(reply, 409, result.guard.code, result.guard.message);
      }
      return reply.status(result.status).send({ data: result.value });
    }
  );

  // POST /api/v1/platform/organizations/:orgId/members/invite
  f.post(
    '/:orgId/members/invite',
    {
      // The organization half is asked in the handler beside the team half: an invitation that
      // carries a team needs `team.members.manage` on that team too, with no exemption.
      onRequest: requireAuth({ handlerChecked: ['org.members.manage', 'team.members.manage'] }),
      schema: {
        body: z.object({
          email: z.string().trim().toLowerCase().email(),
          orgRole: z.enum(['ORG_ADMIN', 'ORG_MEMBER']).default('ORG_MEMBER'),
          teamId: z.string().uuid().optional(),
          teamRole: z.enum(['ADMIN', 'LEAD', 'ENGINEER']).default('ENGINEER'),
        }),
        params: OrgParamsSchema,
      },
    },
    async (request, reply) => {
      const { orgId } = request.params;
      const { email, orgRole, teamId, teamRole } = request.body;
      const orgDecision = await can(request, 'org.members.manage', { orgId });
      if (!orgDecision.allowed) {
        return replyRefusal(reply, orgDecision);
      }
      // Both decisions allowed the invitation; the audit records the more exceptional ground.
      let authority: Authority = orgDecision.authority;
      // The ground of the team decision, written on the TeamMembership row it allowed.
      let teamContext: AuditContext | undefined;
      if (teamId) {
        // A team that does not exist and a team of another organization answer alike, before the
        // team is asked, so the answer does not reveal whether a team exists elsewhere (spec 7b).
        const team = await fastify.prisma.team.findUnique({
          select: { orgId: true },
          where: { id: teamId },
        });
        if (!team || team.orgId !== orgId) {
          return sendError(reply, 400, 'TEAM_ORG_MISMATCH', 'Team must belong to the organization');
        }
        const teamDecision = await can(request, 'team.members.manage', { teamId });
        if (!teamDecision.allowed) {
          return replyRefusal(reply, teamDecision);
        }
        authority = strongestAuthority(authority, teamDecision.authority);
        teamContext = { ...auditContextOf(request), authority: teamDecision.authority };
        // The same rank rule as a team member-add: no grant above the rank the actor acts at.
        const standing = await loadStanding(fastify.prisma, actorOf(request), { teamId });
        const actorRank = actingRank(standing, teamId);
        const granted = teamRankOf(teamRole);
        if (!(actorRank && granted) || TEAM_ROLE_RANK[granted] > TEAM_ROLE_RANK[actorRank]) {
          return sendError(
            reply,
            403,
            'PRIVILEGE_ESCALATION',
            'Cannot grant a role higher than your own'
          );
        }
      }
      const result = await inviteUser(fastify, requireUser(request), {
        authority,
        email,
        orgId,
        orgRole,
        source: 'org_admin',
        teamContext,
        teamId,
        teamRole,
      });
      if (!result.ok) {
        return sendError(reply, result.status, result.code, result.message);
      }
      return reply.status(201).send({ data: { ...result.user, orgRole } });
    }
  );

  // PATCH /api/v1/platform/organizations/:orgId/members/:userId
  f.patch(
    '/:orgId/members/:userId',
    {
      onRequest: requireAuth({ capability: 'org.members.manage', org: { param: 'orgId' } }),
      schema: { body: PatchMemberSchema, params: MemberParamsSchema },
    },
    async (request, reply) => {
      const { orgId, userId } = request.params;
      const { role } = request.body;

      const result = await withOrganizationMembershipLock(fastify, orgId, async (tx) => {
        const row = await tx.organizationMembership.findUnique({
          where: { userId_orgId: { orgId, userId } },
        });
        if (!row) {
          return { missing: true as const };
        }
        const guard = await guardOrgAdminChange(
          tx,
          orgId,
          userId,
          requireUser(request).sub,
          'update',
          row.role,
          role
        );
        if (guard) {
          return { guard };
        }
        const updated = await tx.organizationMembership.update({
          data: { role },
          where: { id: row.id },
        });
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: requireUser(request),
          after: memberAuditFields(updated),
          before: memberAuditFields(row),
          client: tx,
          entityId: row.id,
          entityType: 'OrganizationMembership',
        });
        return { value: updated };
      });
      if ('missing' in result) {
        return sendError(reply, 404, 'NOT_FOUND', 'Membership not found');
      }
      if ('guard' in result && result.guard) {
        return sendError(reply, 409, result.guard.code, result.guard.message);
      }
      return { data: result.value };
    }
  );

  // DELETE /api/v1/platform/organizations/:orgId/members/:userId
  f.delete(
    '/:orgId/members/:userId',
    {
      onRequest: requireAuth({ capability: 'org.members.manage', org: { param: 'orgId' } }),
      schema: { params: MemberParamsSchema },
    },
    async (request, reply) => {
      const { orgId, userId } = request.params;

      const result = await withOrganizationMembershipLock(fastify, orgId, async (tx) => {
        const row = await tx.organizationMembership.findUnique({
          where: { userId_orgId: { orgId, userId } },
        });
        if (!row) {
          return { missing: true as const };
        }
        const guard = await guardOrgAdminChange(
          tx,
          orgId,
          userId,
          requireUser(request).sub,
          'delete',
          row.role,
          undefined,
          isPlatformAdmin(requireUser(request))
        );
        if (guard) {
          return { guard };
        }
        // Leaving the organization ends the person's place in all of its teams, in this
        // transaction: nothing is written until every refusal has been decided.
        const plan = await planTeamCascade(tx, orgId, userId, request.authority);
        if ('guard' in plan) {
          return { guard: plan.guard };
        }
        await tx.organizationMembership.delete({ where: { id: row.id } });
        await writeAuditLog(fastify, {
          action: 'DELETE',
          actor: requireUser(request),
          before: memberAuditFields(row),
          client: tx,
          entityId: row.id,
          entityType: 'OrganizationMembership',
        });
        await removeTeamMemberships(fastify, tx, request, plan.rows);
        return { deleted: true as const };
      });
      if ('missing' in result) {
        return sendError(reply, 404, 'NOT_FOUND', 'Membership not found');
      }
      if ('guard' in result && result.guard) {
        return sendError(reply, 409, result.guard.code, result.guard.message);
      }
      return reply.status(204).send();
    }
  );
};

// Deliberately NOT wrapped in fastify-plugin: `fp()` sets skip-override, and
// Fastify then ignores the `prefix` passed at registration, mounting these
// routes at the server root instead of under /api/v1/admin/organizations.
// The plugin decorates nothing, so encapsulation is exactly what it needs.
export const orgMembersRoutes: FastifyPluginAsync = orgMembersPlugin;
