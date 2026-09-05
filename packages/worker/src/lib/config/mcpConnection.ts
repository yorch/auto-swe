import { prisma } from '@auto-swe/shared/db';
import { isMcpToolEnabled } from '../../agents/mcpTools.js';
import { fetchActiveAgent } from './agentResolver.js';
import { parseToolKeys } from './toolKeys.js';
import type { ResolveCtx } from './types.js';

/**
 * The resolved target of an `mcp`-type Connection: the server URL plus the
 * optional per-connection timeout overrides (`config.listTimeoutMs` /
 * `config.callTimeoutMs`) that `loadMcpTools` accepts as its 3rd `options`
 * arg. Timeouts are omitted (letting `loadMcpTools` fall back to its
 * defaults) unless the config carries a finite, positive number.
 */
export interface McpConnectionTarget {
  url: string;
  listTimeoutMs?: number;
  callTimeoutMs?: number;
}

/** A finite, strictly-positive number — `0`/negative/NaN/Infinity are invalid timeouts. */
function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Resolve the http(s) URL + optional timeout overrides of an `mcp`-type
 * Connection by id (P2/WS3; timeouts added later without a schema change —
 * they live in the same `config` JSON bag as `url`). Returns null when the id
 * is absent, the connection is missing/inactive, not an `mcp` connection, or
 * has no string `config.url`. Never throws — MCP is always best-effort and
 * must not break the activity.
 */
export async function mcpUrlForConnection(
  connectionId: string | null
): Promise<McpConnectionTarget | null> {
  if (!connectionId) {
    return null;
  }
  try {
    const conn = await prisma.connection.findUnique({ where: { id: connectionId } });
    if (!conn?.isActive || conn.type !== 'mcp') {
      return null;
    }
    const config = conn.config as {
      url?: unknown;
      listTimeoutMs?: unknown;
      callTimeoutMs?: unknown;
    } | null;
    const url = config && typeof config === 'object' ? config.url : null;
    if (typeof url !== 'string') {
      return null;
    }
    const listTimeoutMs = readPositiveNumber(config?.listTimeoutMs);
    const callTimeoutMs = readPositiveNumber(config?.callTimeoutMs);
    return {
      url,
      ...(listTimeoutMs !== undefined ? { listTimeoutMs } : {}),
      ...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The MCP connection target an agent should bind tools from for this run: null
 * unless the resolved Agent both enables the `'mcp'` tool key
 * (`isMcpToolEnabled`) and references an active `mcp` Connection with a
 * `config.url` (`mcpConnectionId`).
 */
export async function resolveAgentMcpUrl(
  key: string,
  ctx?: ResolveCtx
): Promise<McpConnectionTarget | null> {
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
  const toolKeys = parseToolKeys(agent.toolKeys);
  if (!isMcpToolEnabled(toolKeys)) {
    return null;
  }
  return mcpUrlForConnection(agent.mcpConnectionId ?? null);
}
