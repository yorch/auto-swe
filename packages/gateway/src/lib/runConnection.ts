import {
  installationRetiredErrorBody,
  isInstallationRetired,
} from '@auto-swe/shared/lib/repoAccessDecision';
import type { RepoAccessGate } from '@auto-swe/shared/lib/repoAccessGate';
import type { WorkspaceProviderMetadata } from '@auto-swe/shared/lib/workspaceProviders';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';
import { authorizeLaunch, sendLaunchRefusal } from './launchAuthorization.js';

export interface ValidateRunConnectionInput {
  connectionId: string | null;
  prisma: FastifyInstance['prisma'];
  providerMeta: WorkspaceProviderMetadata | null;
  templateTeamId: string | null;
  user: JwtPayload | null;
  /**
   * The GitHub permission gate. Required so a caller has to name it — it was
   * optional in an earlier shape and the one caller that needed it applied the
   * gate separately, in its own block, which is the pattern this consolidation
   * exists to end. Undefined means no gate, which is what a public or webhook
   * caller means.
   */
  gate: RepoAccessGate | undefined;
  log?: FastifyBaseLogger;
}

export type ValidateRunConnectionResult =
  | { budgetCap: number | null; budgetOrgId: string | null; ok: true }
  | { ok: false };

/**
 * Shared validation for a run's target connection.
 *
 * - Checks the connection exists and is active.
 * - For authenticated calls, takes the full launch decision (`authorizeLaunch`)
 *   — team membership, GitHub permission, org membership and the connection
 *   org's monthly cap (admins bypass membership and permission, not the cap).
 *   For public/webhook calls there is no user to ask GitHub about, so the only
 *   scope we can trust is the template's own team and the connection must
 *   belong to it.
 * - Validates the connection type against the template's workspace provider.
 * - Returns the budget org and cap. An authenticated caller's connection org has
 *   already been checked; a public/webhook caller passes them to assertOrgBudget.
 *
 * When validation fails this function sends the reply and returns `{ ok: false }`;
 * the caller should `return` immediately.
 */
export async function validateRunConnection(
  input: ValidateRunConnectionInput,
  reply: FastifyReply
): Promise<ValidateRunConnectionResult> {
  const { connectionId, gate, log, prisma, providerMeta, templateTeamId, user } = input;

  let budgetOrgId: string | null = null;
  let budgetCap: number | null = null;

  if (connectionId) {
    const connection = await prisma.connection.findUnique({
      include: {
        installation: { select: { installationId: true, isActive: true } },
        team: {
          include: {
            // Filtered to the acting user. It used to load every member of the
            // team to run a `.some()` over them, which read far more rows than
            // the question needed.
            memberships: {
              select: { userId: true },
              where: user ? { userId: user.sub } : undefined,
            },
            organization: { select: { id: true, monthlyBudgetUsdCents: true } },
          },
        },
      },
      where: { id: connectionId },
    });
    if (!connection?.isActive) {
      reply.status(404).send({
        error: { code: 'CONNECTION_NOT_FOUND', message: 'Connection not found or inactive' },
      });
      return { ok: false };
    }

    // Ahead of the user branch: a public or webhook caller is exempt from the
    // GitHub gate because there is no identity to ask about, and that exemption
    // has nothing to say about whether the installation still exists.
    if (isInstallationRetired(connection)) {
      reply.status(409).send(installationRetiredErrorBody());
      return { ok: false };
    }

    if (user) {
      // The launch decision: repository access, org membership and the org's
      // monthly cap, the same one every other launch path takes.
      const authorization = await authorizeLaunch(prisma, user, {
        gate,
        log,
        repos: [connection],
      });
      if (!authorization.ok) {
        sendLaunchRefusal(reply, authorization.refusal);
        return { ok: false };
      }
    } else if (connection.teamId !== templateTeamId) {
      reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Connection does not belong to this template' },
      });
      return { ok: false };
    }

    if (
      providerMeta?.connectionTypes?.length &&
      !(providerMeta.connectionTypes as string[]).includes(connection.type)
    ) {
      reply.status(400).send({
        error: {
          code: 'CONNECTION_TYPE_MISMATCH',
          message: `Template expects one of ${providerMeta.connectionTypes.join(', ')} connections but got ${connection.type}`,
        },
      });
      return { ok: false };
    }

    budgetOrgId = connection.team.organization?.id ?? null;
    budgetCap = connection.team.organization?.monthlyBudgetUsdCents ?? null;
  } else if (providerMeta?.connectionTypes?.length) {
    reply.status(400).send({
      error: {
        code: 'CONNECTION_REQUIRED',
        message: `Template requires one of ${providerMeta.connectionTypes.join(', ')} connections`,
      },
    });
    return { ok: false };
  }

  return { budgetCap, budgetOrgId, ok: true };
}
