import type { WorkspaceProviderMetadata } from '@auto-swe/shared/lib/workspaceProviders';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';

export interface ValidateRunConnectionInput {
  connectionId: string | null;
  prisma: FastifyInstance['prisma'];
  providerMeta: WorkspaceProviderMetadata | null;
  templateTeamId: string | null;
  user: JwtPayload | null;
}

export type ValidateRunConnectionResult =
  | { budgetCap: number | null; budgetOrgId: string | null; ok: true }
  | { ok: false };

/**
 * Shared validation for a run's target connection.
 *
 * - Checks the connection exists and is active.
 * - For authenticated calls, checks team membership (admins bypass).
 *   For public/webhook calls, the only scope we can trust is the template's
 *   own team, so the connection must belong to that team.
 * - Validates the connection type against the template's workspace provider.
 * - Returns the budget org and cap for the calling code to pass to assertOrgBudget.
 *
 * When validation fails this function sends the reply and returns `{ ok: false }`;
 * the caller should `return` immediately.
 */
export async function validateRunConnection(
  input: ValidateRunConnectionInput,
  reply: FastifyReply
): Promise<ValidateRunConnectionResult> {
  const { connectionId, prisma, providerMeta, templateTeamId, user } = input;

  let budgetOrgId: string | null = null;
  let budgetCap: number | null = null;

  if (connectionId) {
    const connection = await prisma.connection.findUnique({
      include: {
        team: {
          include: {
            memberships: { select: { userId: true } },
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

    if (user) {
      if (
        user.role !== 'ADMIN' &&
        !connection.team.memberships.some((m) => m.userId === user.sub)
      ) {
        reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'You do not have access to this connection' },
        });
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
