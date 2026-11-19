import type { Role } from '@auto-swe/shared';
import { type Authority, isPlatformAdmin } from '@auto-swe/shared/permissions';
import type { FastifyInstance } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';
import { type AuditContext, currentAuditContext } from './auditContext.js';
import { writeAuditLog } from './auditLog.js';
import { getDefaultClientOrigin } from './env.js';
import { isUniqueConstraintError } from './prismaErrors.js';

export async function inviteUser(
  fastify: FastifyInstance,
  actor: JwtPayload,
  args: {
    /**
     * The ground of the capability decision that allowed the invitation. It is written into the audit
     * context of every row the invitation creates. A route that decided with `can()` passes it,
     * because only a route's declarative check records it on the request.
     */
    authority?: Authority;
    email: string;
    orgId: string;
    orgRole: 'ORG_ADMIN' | 'ORG_MEMBER';
    source: 'org_admin' | 'team_lead';
    teamId?: string;
    teamRole?: Role;
  }
) {
  const refusal = (status: number, code: string, message: string) => ({
    code,
    message,
    ok: false as const,
    status,
  });
  const audit: { context?: AuditContext } = args.authority
    ? { context: { ...(currentAuditContext() ?? {}), authority: args.authority } }
    : {};
  let result:
    | ReturnType<typeof refusal>
    | { ok: true; user: { email: string; id: string; isActive: boolean; role: Role } };
  try {
    result = await fastify.prisma.$transaction(async (tx) => {
      // CLAUDE.md §7 exception: serialize membership writes with organization revocations.
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${args.orgId}::uuid FOR UPDATE`;
      if (args.teamId) {
        const team = await tx.team.findUnique({ where: { id: args.teamId } });
        if (!team || team.orgId !== args.orgId) {
          return refusal(400, 'TEAM_ORG_MISMATCH', 'Team must belong to the organization');
        }
      }
      const existing = await tx.user.findFirst({
        where: { email: { equals: args.email, mode: 'insensitive' } },
      });
      if (existing) {
        return refusal(409, 'USER_EXISTS', 'User with this email already exists');
      }
      let approvalSource: string | null = isPlatformAdmin(actor) ? 'admin' : null;
      if (!approvalSource) {
        const org = await tx.organization.findUnique({
          select: { isActive: true, trustedInvites: true },
          where: { id: args.orgId },
        });
        approvalSource = org?.isActive && org.trustedInvites ? args.source : null;
      }
      const approved = approvalSource !== null;
      const user = await tx.user.create({
        data: {
          ...(approvalSource ? { approvalSource, approvedAt: new Date() } : {}),
          email: args.email,
          emailVerified: approved,
          isActive: approved,
          role: 'ENGINEER',
        },
        select: { email: true, id: true, isActive: true, role: true },
      });
      const membership = await tx.organizationMembership.create({
        data: { orgId: args.orgId, role: args.orgRole, userId: user.id },
      });
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor,
        after: { orgId: args.orgId, role: args.orgRole, userId: user.id },
        client: tx,
        ...audit,
        entityId: membership.id,
        entityType: 'OrganizationMembership',
      });
      if (args.teamId) {
        const teamMembership = await tx.teamMembership.create({
          data: { role: args.teamRole ?? 'ENGINEER', teamId: args.teamId, userId: user.id },
        });
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor,
          after: { role: teamMembership.role, teamId: args.teamId, userId: user.id },
          client: tx,
          ...audit,
          entityId: teamMembership.id,
          entityType: 'TeamMembership',
        });
      }
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor,
        after: { approvalSource, email: user.email, isActive: user.isActive, orgId: args.orgId },
        client: tx,
        ...audit,
        entityId: user.id,
        entityType: 'User',
      });
      return { ok: true as const, user };
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return refusal(409, 'USER_EXISTS', 'User with this email already exists');
    }
    throw err;
  }
  if (!result.ok) {
    return result;
  }
  try {
    const { getAuth } = await import('./betterAuth.js');
    await getAuth().api.signInMagicLink({
      body: { callbackURL: `${getDefaultClientOrigin()}/login?bridge=1`, email: args.email },
      headers: new Headers(),
    });
  } catch (err) {
    fastify.log.warn({ err }, 'invite magic-link send failed — user row was created');
  }
  return result;
}
