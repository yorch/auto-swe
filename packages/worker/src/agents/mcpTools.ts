/**
 * MCP tool loading for the implementer agent (EVOL-7: `Repository.mcpServerRef`).
 *
 * `mcpServerRef` is interpreted as an HTTP(S) URL pointing at a streamable-HTTP
 * (or legacy SSE) MCP server. Anything that is not `http://` or `https://` is
 * rejected: stdio MCP servers are deliberately unsupported because the worker
 * must never exec arbitrary commands sourced from a DB column.
 *
 * Failure isolation: an unreachable / misbehaving MCP server must never fail
 * the implementation activity. Every failure path logs, records a tracer
 * activity event (`mcp.invalid_ref` / `mcp.connect_failed`), and returns an
 * empty tool set so the agent continues with its built-in workspace tools.
 *
 * Security:
 * - Every MCP tool call is audit-logged (like the `bash` tool) and recorded
 *   on the AgentTracer with toolName `mcp:<toolName>`.
 * - Loading is gated by the `mcp` pseudo-tool key in `AgentToolConfig`
 *   (see `isMcpToolEnabled`) — any existing tool config disables MCP because
 *   the gateway enum does not yet accept `'mcp'`.
 */
import { randomUUID } from 'node:crypto';
import { isSafeProbeUrl } from '@auto-swe/shared/lib/ssrfGuard';
import { MCP_TOOL_KEY } from '@auto-swe/shared/workflow';
import type { Tool } from '@mastra/core/tools';
import { MCPClient } from '@mastra/mcp';
import type { AgentTracer } from '../lib/agentTracer.js';
import { getErrorMessage } from '../lib/errors.js';

/**
 * Pseudo tool-key that gates MCP tool loading. Re-exported from the shared
 * canonical tool-key set (`AGENT_TOOL_KEYS`) so the gateway, worker, and web
 * agree; an Agent's `toolKeys` may include it (P2/WS2).
 */
export { MCP_TOOL_KEY };

/** Subset of AgentTracer used here — keeps tests free of the Prisma import chain. */
export type McpTracer = Pick<AgentTracer, 'addToolCall' | 'addActivityEvent'>;

// biome-ignore lint/suspicious/noExplicitAny: matches @mastra/mcp's listToolsets() return type
export type McpToolRecord = Record<string, Tool<any, any, any, any>>;

export interface LoadedMcpTools {
  /** Tools keyed `mcp_<sanitized-tool-name>`, ready to merge into the agent's tool record. */
  tools: McpToolRecord;
  /** Disconnects the underlying MCP client. Safe to call multiple times; never throws. */
  close: () => Promise<void>;
}

export interface LoadMcpToolsOptions {
  /** Timeout for connecting + listing tools (default 15 s). */
  listTimeoutMs?: number;
  /** Timeout for each individual MCP tool call (default 60 s). */
  callTimeoutMs?: number;
}

const DEFAULT_LIST_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
/** Internal MCPClient server name — produces stable `mcp_*` namespacing. */
const SERVER_NAME = 'mcp';
const NOOP_CLOSE = async (): Promise<void> => {};

/**
 * MCP gating, mirroring how the four built-in workspace tools are gated:
 * - `null` / empty `enabledTools` (no effective `AgentToolConfig` row) → all
 *   tools enabled, MCP included.
 * - A non-empty config must explicitly contain `'mcp'` — absence disables MCP,
 *   which is automatically the case for every existing config row.
 */
export function isMcpToolEnabled(enabledTools?: string[] | null): boolean {
  if (!enabledTools || enabledTools.length === 0) {
    return true;
  }
  return enabledTools.includes(MCP_TOOL_KEY);
}

/** Validates that an mcpServerRef is an http(s) URL. Returns the parsed URL or null. */
export function parseMcpServerRef(mcpServerRef: string): URL | null {
  let url: URL;
  try {
    url = new URL(mcpServerRef);
  } catch {
    return null;
  }
  // http(s) only — no stdio: a `command` server definition would let a DB
  // column drive arbitrary command execution on the worker host.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  // Defense-in-depth: the gateway's `/mcp-connections` create route already
  // rejects unsafe URLs (SSRF guard) at write time, but re-check here too —
  // this is the worker's last line of defense against a private/loopback/
  // link-local target reaching an MCP server connection.
  if (!isSafeProbeUrl(mcpServerRef).ok) {
    return null;
  }
  return url;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Tool keys must satisfy provider tool-name rules (`[A-Za-z0-9_-]`). */
export function sanitizeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

function safeJson(value: unknown, max = 2_000): string {
  try {
    const s = JSON.stringify(value);
    return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
  } catch {
    return '[unserializable]';
  }
}

/**
 * Wraps an MCP tool's execute in-place with audit logging, tracer recording
 * (toolName `mcp:<name>`), and a per-call timeout. Errors are recorded on the
 * tracer and rethrown — Mastra surfaces tool errors to the model, and we cannot
 * fabricate a schema-conforming error payload for an arbitrary remote tool.
 */
function wrapMcpTool(
  tool: McpToolRecord[string],
  toolName: string,
  serverUrl: string,
  callTimeoutMs: number,
  tracer?: McpTracer
): void {
  const originalExecute = tool.execute?.bind(tool);
  if (!originalExecute) {
    return;
  }
  const tracedName = `mcp:${toolName}`;
  tool.execute = async (...args: Parameters<NonNullable<typeof originalExecute>>) => {
    const input = args[0];
    // Audit line, same spirit as the bash tool's `[bash:audit]` log.
    console.log(`[mcp:audit] server=${serverUrl} tool=${toolName} args=${safeJson(input)}`);
    const start = Date.now();
    try {
      const result = await withTimeout(
        originalExecute(...args),
        callTimeoutMs,
        `MCP tool call '${toolName}'`
      );
      tracer?.addToolCall({
        durationMs: Date.now() - start,
        inputJson: input,
        outputJson: result,
        toolName: tracedName,
      });
      return result;
    } catch (err: unknown) {
      tracer?.addToolCall({
        durationMs: Date.now() - start,
        error: getErrorMessage(err),
        inputJson: input,
        toolName: tracedName,
      });
      throw err;
    }
  };
}

/**
 * Connects to the MCP server referenced by `mcpServerRef` and returns its tools
 * keyed `mcp_<toolName>`, each wrapped with audit logging + tracer recording +
 * per-call timeout. Never throws — all failures return an empty tool set.
 */
export async function loadMcpTools(
  mcpServerRef: string,
  tracer?: McpTracer,
  options?: LoadMcpToolsOptions
): Promise<LoadedMcpTools> {
  const listTimeoutMs = options?.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  const callTimeoutMs = options?.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const start = Date.now();

  const url = parseMcpServerRef(mcpServerRef);
  if (!url) {
    const error = `mcpServerRef must be an http(s) URL (stdio is not supported): ${mcpServerRef}`;
    console.warn(`[mcp] invalid server ref: ${error}`);
    tracer?.addActivityEvent({
      error,
      inputJson: { mcpServerRef },
      name: 'mcp.invalid_ref',
    });
    return { close: NOOP_CLOSE, tools: {} };
  }

  let client: MCPClient | undefined;
  const close = async (): Promise<void> => {
    try {
      await client?.disconnect();
    } catch (err: unknown) {
      console.warn(`[mcp] disconnect failed for ${url}: ${getErrorMessage(err)}`);
    }
  };

  try {
    // Unique id per load — MCPClient caches instances by config otherwise and
    // each implementer activity needs its own connection lifecycle.
    client = new MCPClient({
      id: `implementer-mcp-${randomUUID()}`,
      servers: { [SERVER_NAME]: { timeout: callTimeoutMs, url } },
      timeout: callTimeoutMs,
    });

    const { toolsets, errors } = await withTimeout(
      client.listToolsetsWithErrors(),
      listTimeoutMs,
      `MCP tool listing from ${url}`
    );

    const serverError = errors?.[SERVER_NAME];
    const serverTools = toolsets?.[SERVER_NAME];
    if (serverError || !serverTools) {
      throw new Error(serverError ?? `MCP server ${url} returned no toolset`);
    }

    const tools: McpToolRecord = {};
    for (const [name, tool] of Object.entries(serverTools)) {
      wrapMcpTool(tool, name, url.toString(), callTimeoutMs, tracer);
      tools[`mcp_${sanitizeToolName(name)}`] = tool;
    }

    tracer?.addActivityEvent({
      durationMs: Date.now() - start,
      inputJson: { mcpServerRef },
      name: 'mcp.tools_loaded',
      outputJson: { count: Object.keys(tools).length, tools: Object.keys(tools) },
    });
    console.log(
      `[mcp] loaded ${Object.keys(tools).length} tool(s) from ${url}: ${Object.keys(tools).join(', ')}`
    );
    return { close, tools };
  } catch (err: unknown) {
    // Connection / listing failure must NOT fail the implementation —
    // record the event and continue with built-in workspace tools only.
    const error = getErrorMessage(err);
    console.error(`[mcp] connect failed for ${url}: ${error}`);
    tracer?.addActivityEvent({
      durationMs: Date.now() - start,
      error,
      inputJson: { mcpServerRef },
      name: 'mcp.connect_failed',
    });
    await close();
    return { close: NOOP_CLOSE, tools: {} };
  }
}
