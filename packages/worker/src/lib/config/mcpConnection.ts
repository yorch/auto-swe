import { prisma } from '@auto-swe/shared/db';
import { isMcpToolEnabled } from '../../agents/mcpTools.js';
import { resolveAgent } from './agentResolver.js';
import type { ResolveCtx } from './types.js';

/**
 * Resolve the http(s) URL of an `mcp`-type Connection by id (P2/WS3).
 * Returns null when the id is absent, the connection is missing/inactive, not
 * an `mcp` connection, or has no string `config.url`. Never throws — MCP is
 * always best-effort and must not break the activity.
 */
export async function mcpUrlForConnection(connectionId: string | null): Promise<string | null> {
  if (!connectionId) {
    return null;
  }
  try {
    const conn = await prisma.connection.findUnique({ where: { id: connectionId } });
    if (!conn || !conn.isActive || conn.type !== 'mcp') {
      return null;
    }
    const config = conn.config as { url?: unknown } | null;
    const url = config && typeof config === 'object' ? config.url : null;
    return typeof url === 'string' ? url : null;
  } catch {
    return null;
  }
}

/**
 * The MCP server URL an agent should bind tools from for this run: null unless
 * the resolved Agent both enables the `'mcp'` tool key (`isMcpToolEnabled`) and
 * references an active `mcp` Connection with a `config.url` (`mcpConnectionId`).
 */
export async function resolveAgentMcpUrl(key: string, ctx?: ResolveCtx): Promise<string | null> {
  const agent = await resolveAgent(key, ctx);
  if (!isMcpToolEnabled(agent.toolKeys)) {
    return null;
  }
  return mcpUrlForConnection(agent.mcpConnectionId);
}
