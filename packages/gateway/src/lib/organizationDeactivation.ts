import type { FastifyInstance } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';
import type { AuditContext } from './auditContext.js';
import { writeAuditLog } from './auditLog.js';
import { resolveDefaultOrganizationId } from './defaultOrganization.js';
import { lockOrganizations } from './lockOrder.js';
import { closeOpenJoinRequests } from './teamJoinRequests.js';

/** The organization fields an update may carry beside the active flag. */
export interface OrganizationFieldChanges {
  name?: string | undefined;
  slug?: string | undefined;
  trustedInvites?: boolean | undefined;
}

export interface OrganizationActiveInput {
  actor: JwtPayload;
  context: AuditContext;
  /** The new state; `undefined` leaves it as it is. */
  isActive: boolean | undefined;
  orgId: string;
  /** Other fields changed in the same transaction. */
  fields?: OrganizationFieldChanges;
}

export type OrganizationActiveOutcome =
  | {
      ok: true;
      /** Open join requests the deactivation closed. */
      closedJoinRequests: number;
      organization: {
        id: string;
        isActive: boolean;
        name: string;
        slug: string;
        trustedInvites: boolean;
      };
    }
  | { ok: false; status: 404 | 409; code: string; message: string };

const SELECT = { id: true, isActive: true, name: true, slug: true, trustedInvites: true } as const;

/**
 * Changes an organization's active flag, and any other field sent with it, in one transaction.
 *
 * The organization row is locked first, the lock a join approval takes before the team's, so a
 * decision and a deactivation settle one way or the other: a decision that committed first is
 * left alone, and one that waits sees `isActive = false` and refuses. Deactivating closes every
 * open request of the organization's teams in the same transaction (no cooldown, no notification),
 * so an inactive organization never has a request waiting on it. Reactivating reopens nothing.
 * A value that does not change writes nothing and closes nothing.
 *
 * The default organization cannot be deactivated (`resolveDefaultOrganizationId`: the organization
 * that owns the default team, else the one with the seed's slug): new accounts are enrolled there,
 * and an inactive default organization would leave sign-up with nowhere to put them.
 */
export async function changeOrganizationActive(
  fastify: FastifyInstance,
  input: OrganizationActiveInput
): Promise<OrganizationActiveOutcome> {
  const { actor, context, fields, isActive, orgId } = input;
  return fastify.prisma.$transaction(async (tx): Promise<OrganizationActiveOutcome> => {
    // The organization row lock every membership write and join decision takes before the team's,
    // so a deactivation serializes with them.
    await lockOrganizations(tx, [orgId]);
    const existing = await tx.organization.findUnique({ select: SELECT, where: { id: orgId } });
    if (!existing) {
      return { code: 'NOT_FOUND', message: 'Organization not found', ok: false, status: 404 };
    }

    const deactivating = isActive === false && existing.isActive;
    // Read under the organization's lock: a save of the default team's slug into this organization
    // takes the same lock to check that the organization is active, so it either committed before
    // this read (and is seen) or waits for this deactivation (and is refused).
    if (deactivating && (await resolveDefaultOrganizationId(tx)) === orgId) {
      return {
        code: 'DEFAULT_ORGANIZATION',
        message: 'The organization that owns the default team cannot be deactivated',
        ok: false,
        status: 409,
      };
    }

    const data: OrganizationFieldChanges & { isActive?: boolean } = {};
    for (const key of ['name', 'slug', 'trustedInvites'] as const) {
      if (fields?.[key] !== undefined) {
        Object.assign(data, { [key]: fields[key] });
      }
    }
    if (isActive !== undefined && isActive !== existing.isActive) {
      data.isActive = isActive;
    }
    if (Object.keys(data).length === 0) {
      return { closedJoinRequests: 0, ok: true, organization: existing };
    }

    const organization = await tx.organization.update({
      data,
      select: SELECT,
      where: { id: orgId },
    });
    const closedJoinRequests = deactivating
      ? await closeOpenJoinRequests(fastify, tx, {
          actor,
          context,
          scope: { orgId, reason: 'ORGANIZATION_DEACTIVATED' },
        })
      : 0;
    await writeAuditLog(fastify, {
      action: 'UPDATE',
      actor,
      after: { ...organization, ...(deactivating ? { closedJoinRequests } : {}) },
      before: existing,
      client: tx,
      context,
      entityId: orgId,
      entityType: 'Organization',
    });
    return { closedJoinRequests, ok: true, organization };
  });
}
