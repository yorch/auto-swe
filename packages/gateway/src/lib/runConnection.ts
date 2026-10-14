import { declaredConnectionInputs, type InputSchema } from '@auto-swe/shared/lib/inputSchema';
import {
  installationRetiredErrorBody,
  isInstallationRetired,
} from '@auto-swe/shared/lib/repoAccessDecision';
import type { RepoAccessGate } from '@auto-swe/shared/lib/repoAccessGate';
import { repoMembersSelect } from '@auto-swe/shared/lib/repoMembership';
import type { WorkspaceProviderMetadata } from '@auto-swe/shared/lib/workspaceProviders';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import type { JwtPayload, ServicePrincipalCaller } from '../plugins/auth.js';
import {
  authorizeLaunch,
  authorizeServiceLaunch,
  sendLaunchRefusal,
} from './launchAuthorization.js';
import type { LaunchRepositorySource } from './workflowLaunch.js';

export interface ValidateRunConnectionInput {
  connectionId: string | null;
  prisma: FastifyInstance['prisma'];
  providerMeta: WorkspaceProviderMetadata | null;
  templateTeamId: string | null;
  user: JwtPayload | null;
  /**
   * A service principal launching (with `user` null): the connection is then decided by
   * `authorizeServiceLaunch` — its allowlist, its team's reach and the org's cap — instead of the
   * template-team check a public or webhook caller gets.
   */
  service?: ServicePrincipalCaller;
  /**
   * The GitHub permission gate. Required so a caller has to name it — it was
   * optional in an earlier shape and the one caller that needed it applied the
   * gate separately, in its own block, which is the pattern this consolidation
   * exists to end. Undefined means no gate, which is what a public or webhook
   * caller means.
   */
  gate: RepoAccessGate | undefined;
  log?: FastifyBaseLogger;
  /**
   * The launch payload, and the template's schema for it.
   *
   * A template may declare more than one connection — an issue tracker to read a
   * ticket from and a document store to write the page into — and every one of
   * them is a credential the run is handed. Each therefore takes the same launch
   * decision as the run's own `connectionId`: without this, a caller could name
   * `connectionId` on their own team and a second connection belonging to
   * someone else, and the worker would use that team's token for the write.
   *
   * Omitted (an agent run, a stored retry) means the payload declares nothing
   * beyond `connectionId`.
   */
  payload?: unknown;
  inputSchema?: InputSchema | null;
}

export type ValidateRunConnectionResult =
  | {
      budgetCap: number | null;
      budgetOrgId: string | null;
      ok: true;
      source: LaunchRepositorySource | null;
    }
  | { ok: false };

/** A user id no row can carry, for a membership filter that must match nobody. */
const NO_USER = '00000000-0000-0000-0000-000000000000';

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
  const { connectionId, prisma, providerMeta, service, user } = input;

  let budgetOrgId: string | null = null;
  let budgetCap: number | null = null;
  let source: LaunchRepositorySource | null = null;
  /** The run's own connection type, for a declared field that repeats its id. */
  let primaryConnectionType: string | null = null;

  if (connectionId) {
    // A principal is answered from its allowlist before anything is looked up, and exactly as
    // for a connection that does not exist: it cannot probe which connection ids exist, are
    // inactive or sit behind a retired installation.
    if (service && !service.connectionIds.includes(connectionId)) {
      reply.status(404).send({
        error: { code: 'CONNECTION_NOT_FOUND', message: 'Connection not found or inactive' },
      });
      return { ok: false };
    }
    const connection = await findLaunchConnection(prisma, connectionId, user);
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

    if (!(await authorizeConnectionAccess(input, connection, reply))) {
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
    primaryConnectionType = connection.type;
    if (connection.team.orgId) {
      source = { orgId: connection.team.orgId, repoId: connection.id, teamId: connection.teamId };
    }
  } else if (providerMeta?.connectionTypes?.length) {
    reply.status(400).send({
      error: {
        code: 'CONNECTION_REQUIRED',
        message: `Template requires one of ${providerMeta.connectionTypes.join(', ')} connections`,
      },
    });
    return { ok: false };
  }

  // Every other connection the payload names takes the same decision as the run's
  // own. A template may read from one connection and write to another, and the
  // worker uses whichever the node resolves — so an unauthorized second
  // connection would hand a run someone else's credential for an external write.
  if (!(await authorizeDeclaredConnections(input, reply, primaryConnectionType))) {
    return { ok: false };
  }

  return { budgetCap, budgetOrgId, ok: true, source };
}

/**
 * The connection row a launch decision reads, in the shape `decideRepoAccess`
 * needs: the acting user's memberships (they have to be a member of the owning
 * team, or of a team the connection is shared with) and the owning team's org.
 *
 * One query builder for the run's own connection and for every connection the
 * payload declares, so a second connection cannot be checked against a thinner
 * row than the first.
 */
function findLaunchConnection(
  prisma: FastifyInstance['prisma'],
  connectionId: string,
  user: JwtPayload | null
) {
  return prisma.connection.findUnique({
    include: {
      installation: { select: { host: true, installationId: true, isActive: true } },
      // `teamId` too, for a service principal, whose reach is its team's.
      shares: {
        select: {
          ...repoMembersSelect({ userId: true }, { userId: user?.sub ?? NO_USER }).shares.select,
          teamId: true,
        },
      },
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
}

type LaunchConnection = NonNullable<Awaited<ReturnType<typeof findLaunchConnection>>>;

/**
 * Whether this caller may hand a run this connection: the same decision for the
 * run's own connection and for every one its payload declares.
 *
 * A public or webhook caller has no identity to ask, so the only scope that can
 * be trusted is the template's own team. A service principal is answered from
 * its allowlist before any lookup, so it cannot probe which ids exist.
 */
async function authorizeConnectionAccess(
  input: ValidateRunConnectionInput,
  connection: LaunchConnection,
  reply: FastifyReply
): Promise<boolean> {
  const { prisma, user, service } = input;
  if (user) {
    // The launch decision: connection access, org membership and the org's
    // monthly cap, the same one every other launch path takes.
    const authorization = await authorizeLaunch(prisma, user, {
      gate: input.gate,
      log: input.log,
      repos: [connection],
      // An authenticated template run is launched as its caller
      // (`launchedById`); a public or webhook caller never reaches here.
      runIdentity: 'caller',
    });
    if (!authorization.ok) {
      sendLaunchRefusal(reply, authorization.refusal);
      return false;
    }
    return true;
  }
  if (service) {
    return authorizeServiceConnection(input, connection, reply);
  }
  if (connection.teamId !== input.templateTeamId) {
    reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'Connection does not belong to this template' },
    });
    return false;
  }
  return true;
}

/** The service-principal branch, shared by the run's connection and a declared one. */
async function authorizeServiceConnection(
  input: ValidateRunConnectionInput,
  connection: LaunchConnection,
  reply: FastifyReply
): Promise<boolean> {
  const service = input.service;
  if (!service) {
    return true;
  }
  if (!service.connectionIds.includes(connection.id)) {
    reply.status(404).send({
      error: { code: 'CONNECTION_NOT_FOUND', message: 'Connection not found or inactive' },
    });
    return false;
  }
  const authorization = await authorizeServiceLaunch(input.prisma, service, {
    repos: [connection],
  });
  if (!authorization.ok) {
    sendLaunchRefusal(reply, authorization.refusal);
    return false;
  }
  return true;
}

/**
 * Authorize every connection the payload supplies for a `connection`-typed input
 * the template declares, including the field the run is scoped to.
 *
 * The run's own connection has already taken the access decision, so it is not
 * looked up and authorized again — but its declared `connectionType` is still
 * enforced, against the type already loaded. That is what stops a `document`
 * template that declares `notion` from being launched with a Confluence
 * connection: the provider accepts both, and its Notion-shaped write nodes would
 * then be handed a payload the Confluence handler refuses.
 *
 * Every field is decided on the *id it names*, never on its name: a field called
 * `connectionId` that carries something other than the run's own id is treated as
 * any other declared connection.
 */
async function authorizeDeclaredConnections(
  input: ValidateRunConnectionInput,
  reply: FastifyReply,
  primaryConnectionType: string | null
): Promise<boolean> {
  const declared = declaredConnectionInputs(input.inputSchema, input.payload);
  // A service principal is answered from its allowlist before any lookup, so it
  // cannot probe which connection ids exist, are inactive, or are another team's.
  for (const { connectionId, expectedType, field } of declared) {
    const repeatsPrimary = connectionId === input.connectionId;
    let connectionType = repeatsPrimary ? primaryConnectionType : null;
    if (!repeatsPrimary) {
      if (input.service && !input.service.connectionIds.includes(connectionId)) {
        reply.status(404).send({
          error: { code: 'CONNECTION_NOT_FOUND', message: 'Connection not found or inactive' },
        });
        return false;
      }
      const connection = await findLaunchConnection(input.prisma, connectionId, input.user);
      if (!connection?.isActive) {
        reply.status(404).send({
          error: { code: 'CONNECTION_NOT_FOUND', message: 'Connection not found or inactive' },
        });
        return false;
      }
      if (isInstallationRetired(connection)) {
        reply.status(409).send(installationRetiredErrorBody());
        return false;
      }
      if (!(await authorizeConnectionAccess(input, connection, reply))) {
        return false;
      }
      connectionType = connection.type;
    }
    if (expectedType && connectionType !== expectedType) {
      reply.status(400).send({
        error: {
          code: 'CONNECTION_TYPE_MISMATCH',
          message: `Template expects '${field}' to be a ${expectedType} connection but got ${connectionType ?? 'none'}`,
        },
      });
      return false;
    }
  }
  return true;
}
