import { prisma } from '@auto-swe/shared/db';
import { isMcpToolEnabled } from '../../agents/mcpTools.js';
import { fetchActiveAgent } from './agentResolver.js';
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
    if (!conn?.isActive || conn.type !== 'mcp') {
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
  // Read the raw Agent row (no model bind / credential decrypt — only toolKeys +
  // mcpConnectionId are needed) and stay best-effort: a resolution error must
  // never break the activity, which degrades to built-in tools.
  let agent: Awaited<ReturnType<typeof fetchActiveAgent>>;
  try {
    agent = await fetchActiveAgent(key, ctx);
  } catch {
    return null;
  }
  if (!agent) {
    return null;
  }
  const toolKeys = Array.isArray(agent.toolKeys)
    ? (agent.toolKeys as unknown[]).filter((v): v is string => typeof v === 'string')
    : null;
  if (!isMcpToolEnabled(toolKeys)) {
    return null;
  }
  return mcpUrlForConnection(agent.mcpConnectionId ?? null);
}
