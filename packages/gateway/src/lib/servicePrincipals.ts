/**
 * Service principals (docs/service-principals.md): team-owned machine identities that start and
 * follow runs with tokens of their own, instead of a person's personal access token.
 *
 * What lives here is what a launch by a principal adds to the launch every caller takes: the
 * check, inside the transaction that writes the run's ledger rows, that the principal may still
 * launch this, and its own two limits.
 */
import type { Prisma } from '@auto-swe/shared';
import { isRepoTeam } from '@auto-swe/shared/lib/repoMembership';
import { ACTIVE_WORKFLOW_TERMINAL_STATUSES } from '@auto-swe/shared/types/api';
import type { FastifyReply } from 'fastify';
import type { ServicePrincipalCaller } from '../plugins/auth.js';
import { sendError } from './httpErrors.js';
import { lockConnections, lockServicePrincipal, lockUser } from './lockOrder.js';
import type { LaunchGuard } from './workflowLaunch.js';

/** Refusal codes the launch guard returns; each maps to one response. */
export const SERVICE_LAUNCH_REFUSALS = {
  connectionNotAllowed: 'SERVICE_CONNECTION_NOT_ALLOWED',
  dailyLimit: 'SERVICE_DAILY_LIMIT_REACHED',
  disabled: 'SERVICE_PRINCIPAL_DISABLED',
  inFlightLimit: 'SERVICE_IN_FLIGHT_LIMIT_REACHED',
  templateNotAllowed: 'SERVICE_TEMPLATE_NOT_ALLOWED',
} as const;

const REFUSAL_RESPONSES: Record<string, { status: number; message: string }> = {
  [SERVICE_LAUNCH_REFUSALS.connectionNotAllowed]: {
    message: "This connection is not on the service principal's allowlist",
    status: 403,
  },
  [SERVICE_LAUNCH_REFUSALS.dailyLimit]: {
    message: 'The service principal has started its maximum number of runs in the last 24 hours',
    status: 429,
  },
  [SERVICE_LAUNCH_REFUSALS.disabled]: {
    message: 'The service principal is disabled',
    status: 403,
  },
  [SERVICE_LAUNCH_REFUSALS.inFlightLimit]: {
    message: 'The service principal already has its maximum number of runs in flight',
    status: 429,
  },
  [SERVICE_LAUNCH_REFUSALS.templateNotAllowed]: {
    message: "This template is not on the service principal's allowlist",
    status: 403,
  },
};

const DAY_MS = 24 * 60 * 60 * 1000;
const TERMINAL = [...ACTIVE_WORKFLOW_TERMINAL_STATUSES];

/** What one launch by a principal targets. */
export interface ServiceLaunchTarget {
  connectionId: string | null;
  /** A template run's template; absent for an agent run, which the connection allowlist governs. */
  templateId?: string;
  /**
   * The user the launch also acts as, when it carries one. A principal's own launch has none; a
   * launch that did would lock this row before the principal's (`lockOrder.ts`).
   */
  actorId?: string | undefined;
}

/**
 * The row locks of a principal's launch, in the global order (`lockOrder.ts`): the principal's row
 * (level 2), then the target repository's connection (level 3), after the acting user's row
 * (level 1) when the launch carries one. A launch by a principal carries none today. Returns false when the
 * principal is gone. A transaction that takes a lock of a later level (an orchestration's row)
 * calls this before it, so the guard's own locks are already held when the guard runs.
 */
export async function lockServiceLaunch(
  tx: Prisma.TransactionClient,
  servicePrincipalId: string,
  connectionId: string | null,
  actorId?: string
): Promise<boolean> {
  if (actorId) {
    await lockUser(tx, actorId);
  }
  if (!(await lockServicePrincipal(tx, servicePrincipalId))) {
    return false;
  }
  if (connectionId) {
    await lockConnections(tx, [connectionId]);
  }
  return true;
}

/**
 * The principal's side of a launch, as a guard `launchTrackedWorkflow` runs inside the
 * transaction that writes the run's ledger rows.
 *
 * It takes the principal's row lock first, so two launches by one principal count one after the
 * other, and an edit to its allowlists or limits (an `UPDATE` of the same row) either lands before
 * this launch reads them or waits for it to commit. Then, fresh from the row: not disabled, team
 * active, the target still on its allowlists and its repository still owned by or shared with
 * the principal's team, fewer than `maxRunsPerDay` runs requested in the last
 * 24 hours and fewer than `maxInFlight` ledger rows not yet terminal. Every check before this one
 * read what the token's request loaded; this is the one that decides.
 */
export function servicePrincipalLaunchGuard(
  servicePrincipalId: string,
  target: ServiceLaunchTarget
): LaunchGuard {
  return async (tx: Prisma.TransactionClient) => {
    // The locks of one principal's launch, in the global order (`lockOrder.ts`).
    if (!(await lockServiceLaunch(tx, servicePrincipalId, target.connectionId, target.actorId))) {
      return SERVICE_LAUNCH_REFUSALS.disabled;
    }
    const sp = await tx.servicePrincipal.findUnique({
      select: {
        connectionIds: true,
        disabledAt: true,
        maxInFlight: true,
        maxRunsPerDay: true,
        team: { select: { isActive: true } },
        teamId: true,
        templateIds: true,
      },
      where: { id: servicePrincipalId },
    });
    if (!sp || sp.disabledAt || !sp.team.isActive) {
      return SERVICE_LAUNCH_REFUSALS.disabled;
    }
    if (target.connectionId) {
      if (!sp.connectionIds.includes(target.connectionId)) {
        return SERVICE_LAUNCH_REFUSALS.connectionNotAllowed;
      }
      // The repository must still be the principal's team's, owned or shared: a share removed or
      // a repository moved since the grant ends the grant's effect. Share writers and repository
      // moves take this row lock, so the answer holds until the ledger rows commit.
      const connection = (await lockConnections(tx, [target.connectionId])).length
        ? await tx.connection.findUnique({
            select: { isActive: true, shares: { select: { teamId: true } }, teamId: true },
            where: { id: target.connectionId },
          })
        : null;
      if (!connection?.isActive || !isRepoTeam(connection, sp.teamId)) {
        return SERVICE_LAUNCH_REFUSALS.connectionNotAllowed;
      }
    }
    if (target.templateId && !sp.templateIds.includes(target.templateId)) {
      return SERVICE_LAUNCH_REFUSALS.templateNotAllowed;
    }
    const lastDay = await tx.runInput.count({
      where: {
        createdAt: { gte: new Date(Date.now() - DAY_MS) },
        requestedByServiceId: servicePrincipalId,
      },
    });
    if (lastDay >= sp.maxRunsPerDay) {
      return SERVICE_LAUNCH_REFUSALS.dailyLimit;
    }
    const inFlight = await tx.activeWorkflow.count({
      where: {
        currentStatus: { notIn: TERMINAL },
        workRequest: { requestedByServiceId: servicePrincipalId },
      },
    });
    if (inFlight >= sp.maxInFlight) {
      return SERVICE_LAUNCH_REFUSALS.inFlightLimit;
    }
    return null;
  };
}

/** Send the response for a refusal from {@link servicePrincipalLaunchGuard}. */
export function sendServiceLaunchRefusal(reply: FastifyReply, code: string) {
  const response = REFUSAL_RESPONSES[code] ?? { message: 'Launch refused', status: 403 };
  return sendError(reply, response.status, code, response.message);
}

/**
 * The `Idempotency-Key` scope for a caller. A principal's keys are its own: they can neither
 * collide with a person's nor reveal through a 409 that another caller used the same key. A
 * principal is scoped by its whole id (`s` + 32 hex), so no two principals ever share a scope;
 * a person keeps the 8-hex prefix their workflow ids always had. The longest result, an agent
 * run's `agent-<8>-s<32>-<16>`, is 65 characters.
 */
export function idempotencyCallerScope(
  caller:
    | { kind: 'user'; user: { sub: string } }
    | { kind: 'service'; principal: ServicePrincipalCaller }
): string {
  return caller.kind === 'service'
    ? `s${caller.principal.servicePrincipalId.replace(/-/g, '')}`
    : caller.user.sub.replace(/-/g, '').slice(0, 8);
}

/**
 * The template rows a principal may run: ACTIVE, on its allowlist, and global or its own team's.
 * The team term holds even if an allowlist somehow names another team's template.
 */
export function serviceLaunchableTemplateWhere(
  principal: Pick<ServicePrincipalCaller, 'teamId' | 'templateIds'>,
  templateId: string
): Prisma.WorkflowTemplateWhereInput {
  return {
    AND: [
      { id: templateId, status: 'ACTIVE' },
      { id: { in: principal.templateIds } },
      { OR: [{ teamId: null }, { teamId: principal.teamId }] },
    ],
  };
}
