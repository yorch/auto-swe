import { prisma } from '@auto-swe/shared/db';
import { decryptSecret } from '@auto-swe/shared/lib/crypto';
import { type McpHeader, openMcpHeaders } from '@auto-swe/shared/lib/mcpHeaders';
import { isMcpToolEnabled } from '../../agents/mcpTools.js';
import { logWarn } from '../activityLog.js';
import type { AgentTracer } from '../agentTracer.js';
import { type AgentConnectionTenant, agentMayUseConnection } from '../connectionAccess.js';
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
  /**
   * The decrypted bearer token, when the connection has one. Defined NON-enumerable so a spread,
   * `JSON.stringify`, `Object.entries` or a log of the target can never carry it; consumers read
   * `target.bearerToken` by name and hand it to `loadMcpTools`.
   */
  readonly bearerToken?: string;
  /** The admin's opt-in for a server on a private address (never loopback or metadata). */
  allowPrivateNetwork?: boolean;
  /** Decrypted custom headers; non-enumerable for the same reason as `bearerToken`. */
  readonly headers?: readonly McpHeader[];
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
      allowPrivateNetwork?: unknown;
    } | null;
    const url = config && typeof config === 'object' ? config.url : null;
    if (typeof url !== 'string') {
      return null;
    }
    const listTimeoutMs = readPositiveNumber(config?.listTimeoutMs);
    const callTimeoutMs = readPositiveNumber(config?.callTimeoutMs);
    const target: McpConnectionTarget = {
      url,
      ...(config?.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
      ...(listTimeoutMs !== undefined ? { listTimeoutMs } : {}),
      ...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
    };
    if (conn.apiKeyCiphertext && conn.apiKeyNonce && conn.apiKeyAuthTag) {
      let bearerToken: string;
      try {
        bearerToken = decryptSecret({
          authTag: conn.apiKeyAuthTag,
          ciphertext: conn.apiKeyCiphertext,
          keyVersion: conn.apiKeyVersion,
          nonce: conn.apiKeyNonce,
        });
      } catch {
        // Connecting without the credential the server expects can only fail confusingly, so
        // the connection yields no tools. The error text is not logged: it is the crypto layer's.
        console.warn(
          `[mcp] stored bearer token for connection ${connectionId} cannot be decrypted`
        );
        return null;
      }
      Object.defineProperty(target, 'bearerToken', { enumerable: false, value: bearerToken });
    }
    let headers: McpHeader[];
    try {
      headers = openMcpHeaders(conn);
    } catch {
      // Same stance as an unreadable token: connecting without the headers the server expects can
      // only fail confusingly. Nothing from the crypto layer's error is logged.
      console.warn(`[mcp] stored headers for connection ${connectionId} cannot be read`);
      return null;
    }
    if (headers.length > 0) {
      Object.defineProperty(target, 'headers', { enumerable: false, value: headers });
    }
    return target;
  } catch {
    return null;
  }
}

/** What binding an Agent's MCP configuration yields for this run. */
export type AgentMcpBinding =
  | { kind: 'none' }
  | { kind: 'refused'; connectionId: string }
  | { kind: 'bound'; target: McpConnectionTarget };

export interface AgentMcpOptions {
  /**
   * What the connection is checked against; defaults to the resolution `ctx`. A caller that
   * resolves the Agent in a narrower cascade than the run's tenant — an agent run resolves at
   * GLOBAL and ORGANIZATION scope only, so its `ctx` carries no team — passes the run's team.
   */
  tenant?: AgentConnectionTenant;
  /** Records `mcp.binding_refused` (with a `reason`) when the connection is not bound for the run. */
  tracer?: Pick<AgentTracer, 'addActivityEvent'>;
}

/**
 * The MCP binding an agent gets for this run. `none` unless the resolved Agent both enables the
 * `'mcp'` tool key (`isMcpToolEnabled`) and references an active `mcp` Connection with a
 * `config.url` (`mcpConnectionId`).
 *
 * `refused` when the connection is active but this run's team does not own it, or the check itself
 * failed (`agentMayUseConnection`; the logged and traced `reason` is `refused` or `check_failed`):
 * the credential is never read. The agent continues with its built-in tools, as for every other unusable binding. A
 * caller that falls back to another Agent's binding must not do so on `refused`.
 *
 * Never throws: a resolution error yields `none`.
 */
export async function resolveAgentMcpBinding(
  key: string,
  ctx?: ResolveCtx,
  options: AgentMcpOptions = {}
): Promise<AgentMcpBinding> {
  // Read the raw Agent row (no model bind / credential decrypt — only toolKeys +
  // mcpConnectionId are needed) and stay best-effort: a resolution error must
  // never break the activity, which degrades to built-in tools.
  let agent: Awaited<ReturnType<typeof fetchActiveAgent>>;
  try {
    agent = await fetchActiveAgent(key, ctx);
  } catch {
    return { kind: 'none' };
  }
  if (!agent) {
    return { kind: 'none' };
  }
  const toolKeys = parseToolKeys(agent.toolKeys);
  if (!isMcpToolEnabled(toolKeys)) {
    return { kind: 'none' };
  }
  const connectionId = agent.mcpConnectionId ?? null;
  if (!connectionId) {
    return { kind: 'none' };
  }
  const access = await agentMayUseConnection(connectionId, options.tenant ?? ctx);
  if (access !== 'allowed') {
    logWarn('agent MCP connection is not usable by this run; continuing without its tools', {
      agentKey: key,
      connectionId,
      reason: access,
    });
    options.tracer?.addActivityEvent({
      name: 'mcp.binding_refused',
      outputJson: { agentKey: key, connectionId, reason: access },
    });
    return { connectionId, kind: 'refused' };
  }
  const target = await mcpUrlForConnection(connectionId);
  return target ? { kind: 'bound', target } : { kind: 'none' };
}

/** The connection target of {@link resolveAgentMcpBinding}, or null when nothing is bound. */
export async function resolveAgentMcpUrl(
  key: string,
  ctx?: ResolveCtx,
  options?: AgentMcpOptions
): Promise<McpConnectionTarget | null> {
  const binding = await resolveAgentMcpBinding(key, ctx, options);
  return binding.kind === 'bound' ? binding.target : null;
}
