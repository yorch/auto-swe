import { prisma } from '@auto-swe/shared/db';
import { QODO_INTEGRATION } from '@auto-swe/shared/lib/qodoConnection';
import { logWarn } from '../activityLog.js';
import { type McpConnectionTarget, mcpUrlForConnection } from '../config/mcpConnection.js';
import { agentMayUseConnection } from '../connectionAccess.js';

/**
 * The Qodo `mcp` Connection the team owns, with its resolved target (URL, credential, read-only
 * tool allowlist, result screening), or null when the team has none.
 *
 * Authority is the caller's team and nothing else. The team is the run's repository's team, passed
 * by the caller, and the connection must belong to it: no template names a connection, and a
 * platform-wide or another team's Qodo connection is never returned. A team with several marked
 * connections gets the oldest. The access check runs even though the query already scopes by team,
 * so a change to either cannot widen the other.
 *
 * Never throws: null means "not configured" and callers degrade without Qodo.
 */
export async function resolveQodoConnection(tenant: {
  teamId: string;
}): Promise<{ connectionId: string; target: McpConnectionTarget } | null> {
  if (!tenant.teamId) {
    return null;
  }
  try {
    const conn = await prisma.connection.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
      where: {
        config: { equals: QODO_INTEGRATION, path: ['integration'] },
        isActive: true,
        teamId: tenant.teamId,
        type: 'mcp',
      },
    });
    if (!conn) {
      return null;
    }
    const access = await agentMayUseConnection(conn.id, { teamId: tenant.teamId });
    if (access !== 'allowed') {
      logWarn('the team Qodo connection is not usable by this run; continuing without Qodo', {
        connectionId: conn.id,
        reason: access,
      });
      return null;
    }
    const target = await mcpUrlForConnection(conn.id);
    return target ? { connectionId: conn.id, target } : null;
  } catch {
    return null;
  }
}
