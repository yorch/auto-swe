import type { ConfigScope, Prisma, PrismaClient } from '../generated/prisma/client.js';

/**
 * Identifies one Agent lineage — a key at one scope, with the discriminators that make the scope
 * concrete. Every writer that can change a lineage's activation, and every writer that cuts one of
 * its versions, uses this to agree on what "the same lineage" means.
 */
export interface AgentLineageKey {
  key: string;
  scope: ConfigScope;
  teamId?: string | null;
  orgId?: string | null;
  channelId?: string | null;
  workflowTemplateId?: string | null;
}

/** The string a lineage locks on. Agent keys cannot contain `|`, so the parts cannot be confused. */
export function agentLineageLockKey(key: AgentLineageKey): string {
  return [
    'agent-lineage',
    key.key,
    key.scope,
    key.teamId ?? '',
    key.orgId ?? '',
    key.channelId ?? '',
    key.workflowTemplateId ?? '',
  ].join('|');
}

// CLAUDE.md §7 exception: Prisma cannot express a transaction-scoped advisory lock.
//
// Deactivating a lineage writes no new version, so a version check alone cannot order an edit
// against it: an edit could read an active head, lose to a deactivation that landed in between, and
// still write the lineage back on. This lives in `shared` rather than beside its gateway callers
// because the gateway's agent library and the boot-time seeded-default migration in `syncBuiltins`
// are both writers of the same rows, and a lock only orders writers that take it.
export const lockAgentLineage = (tx: Prisma.TransactionClient, key: AgentLineageKey) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${agentLineageLockKey(key)}, 0))`;

/** The activation a lineage holds right now, its highest version's, read by the caller's client. */
export async function activeLineageHead(
  db: PrismaClient | Prisma.TransactionClient,
  key: AgentLineageKey
): Promise<{ isActive: boolean; version: number } | null> {
  return db.agent.findFirst({
    orderBy: { version: 'desc' },
    select: { isActive: true, version: true },
    where: {
      channelId: key.scope === 'CHANNEL' ? (key.channelId ?? null) : null,
      key: key.key,
      orgId: key.scope === 'ORGANIZATION' ? (key.orgId ?? null) : null,
      scope: key.scope,
      teamId: key.scope === 'TEAM' ? (key.teamId ?? null) : null,
      workflowTemplateId:
        key.scope === 'WORKFLOW_TEMPLATE' ? (key.workflowTemplateId ?? null) : null,
    },
  });
}
