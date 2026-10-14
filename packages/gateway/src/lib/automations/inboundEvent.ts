/**
 * Inbound events into the automation engine (docs/inbound-events.md): one verified event on a
 * team's endpoint → the team's first enabled `inbound.event` automation on that endpoint whose
 * filters select it → one decision under the endpoint's owner key (`@endpoint/<id>`).
 */
import type { PrismaClient } from '@auto-swe/shared';
import {
  endpointOwnerKey,
  INBOUND_EVENT,
  type InboundEvent,
  inboundEventFacts,
  inboundEventSource,
} from '@auto-swe/shared/automation';
import { isInstallationRetired } from '@auto-swe/shared/lib/repoAccessDecision';
import type { FastifyInstance } from 'fastify';
import {
  type AutomationResult,
  connectionInclude,
  decideAndStart,
  type EngineConnection,
  type EngineTeam,
  parseFilters,
} from './engine.js';

/** Why a team automation's target repository cannot be used now. */
export const TARGET_UNAVAILABLE =
  'the repository this automation acts on is inactive, or no longer owned by or shared with its team';

/**
 * The repository a team automation's runs act on, as the engine reads it: an active git
 * repository whose installation is not retired, owned by the team or shared with it. Null when
 * it is none of those any more.
 */
export async function loadTargetConnection(
  prisma: PrismaClient,
  connectionId: string,
  teamId: string
): Promise<EngineConnection | null> {
  const connection = await prisma.connection.findFirst({
    include: connectionInclude,
    where: {
      id: connectionId,
      isActive: true,
      OR: [{ teamId }, { shares: { some: { teamId } } }],
      type: 'git_repo',
    },
  });
  return connection && !isInstallationRetired(connection) ? connection : null;
}

/**
 * Decide one verified event: the oldest matching automation acts, and at most one run starts
 * however many match. The event's facts are the matching automation's (its rules' values and its
 * mapped fields), and they are what the ledger keeps.
 */
export async function handleInboundEvent(
  fastify: FastifyInstance,
  endpoint: { id: string; teamId: string; team: EngineTeam },
  event: InboundEvent,
  now: Date = new Date(),
  startRetryDelayMs = 1_000
): Promise<AutomationResult> {
  const prisma = fastify.prisma;
  const automations = await prisma.automation.findMany({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    where: {
      connectionId: null,
      enabled: true,
      filters: { equals: endpoint.id, path: ['endpointId'] },
      source: INBOUND_EVENT,
      teamId: endpoint.teamId,
    },
  });
  for (const automation of automations) {
    const filters = parseFilters(inboundEventSource, automation.filters);
    if (filters === null) {
      continue;
    }
    const facts = inboundEventFacts(event, filters);
    if (inboundEventSource.mismatch(filters, facts) !== null) {
      continue;
    }
    const connection = automation.targetConnectionId
      ? await loadTargetConnection(prisma, automation.targetConnectionId, endpoint.teamId)
      : null;
    return decideAndStart(fastify, inboundEventSource, {
      automation,
      connection,
      facts,
      now,
      ownerKey: endpointOwnerKey(endpoint.id),
      // A redelivered event takes a failed start again; any other earlier decision stands.
      retry: { kind: 'redelivery' },
      startRetryDelayMs,
      team: endpoint.team,
      ...(automation.targetConnectionId && !connection
        ? { targetUnavailable: TARGET_UNAVAILABLE }
        : {}),
    });
  }
  return { ignored: true, reason: 'no matching automation' };
}
