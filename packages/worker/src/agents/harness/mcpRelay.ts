import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { auditLog } from '../../lib/activityLog.js';
import { redactString } from '../../lib/agentTracer.js';
import type { McpConnectionTarget } from '../../lib/config/mcpConnection.js';
import { getErrorMessage } from '../../lib/errors.js';
import {
  bearerFetch,
  guardedMcpFetch,
  type McpTracer,
  originScopedFetch,
  parseMcpServerRef,
  scrubToken,
  withTimeout,
} from '../mcpTools.js';

const DEFAULT_LIST_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/**
 * An agent's MCP connection, served to a harness from the worker.
 *
 * The worker connects to the remote server (through the same guarded fetch,
 * credential and private-network rules as the Mastra loop's binding) and
 * offers its tools, with their own schemas, through an in-process MCP server
 * the harness's client talks to over its existing pipe. Each call the harness
 * makes is run here, so the connection's token and headers never enter the
 * workspace container, and each is audit-logged as the Mastra binding's are.
 */
export interface McpRelay {
  /**
   * A fresh in-process server for one harness session to connect to; the remote
   * connection behind it is shared. Close it when the session ends.
   */
  createServer(): McpServer;
  /** The remote tools, as the harness sees them (names unprefixed). */
  tools: readonly Tool[];
  /** Per-call timeout, for a harness that bounds calls itself. */
  callTimeoutMs: number;
  /** Disconnects from the remote server. Safe to call more than once; never throws. */
  close(): Promise<void>;
}

type McpFetch = ReturnType<typeof bearerFetch>;

async function connect(url: URL, fetch: McpFetch, timeoutMs: number): Promise<Client> {
  // Streamable HTTP first, then the legacy SSE transport, as the Mastra client does.
  const attempt = async (transport: StreamableHTTPClientTransport | SSEClientTransport) => {
    const client = new Client({ name: 'auto-swe-harness-relay', version: '1.0.0' });
    try {
      await withTimeout(client.connect(transport), timeoutMs, `MCP connection to ${url}`);
      return client;
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
  };
  try {
    return await attempt(new StreamableHTTPClientTransport(url, { fetch }));
  } catch (streamable) {
    try {
      return await attempt(new SSEClientTransport(url, { fetch }));
    } catch {
      throw streamable;
    }
  }
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

const failure = (text: string): CallToolResult => ({
  content: [{ text, type: 'text' }],
  isError: true,
});

/**
 * Opens the relay for `target`, or `null` when the server cannot be reached or
 * listed — never throws: as with the Mastra binding, an unreachable MCP server
 * leaves the agent with its workspace tools rather than failing the activity.
 * The trace records `mcp.tools_loaded`, `mcp.invalid_ref` or `mcp.connect_failed`.
 */
export async function openMcpRelay(
  target: McpConnectionTarget,
  tracer?: McpTracer
): Promise<McpRelay | null> {
  const listTimeoutMs = target.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  const callTimeoutMs = target.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const allowPrivate = target.allowPrivateNetwork === true;
  const start = Date.now();

  const url = parseMcpServerRef(target.url, allowPrivate);
  if (!url) {
    tracer?.addActivityEvent({
      error: `mcpServerRef must be an http(s) URL the worker may reach: ${target.url}`,
      inputJson: { mcpServerRef: target.url },
      name: 'mcp.invalid_ref',
    });
    return null;
  }
  const fetch =
    target.bearerToken || target.headers?.length
      ? bearerFetch(url, target.bearerToken, originScopedFetch(url, allowPrivate), target.headers)
      : guardedMcpFetch(url, allowPrivate);

  let client: Client;
  let tools: Tool[];
  try {
    client = await connect(url, fetch, listTimeoutMs);
    tools = await withTimeout(listAllTools(client), listTimeoutMs, `MCP tool listing from ${url}`);
  } catch (err) {
    tracer?.addActivityEvent({
      durationMs: Date.now() - start,
      error: scrubToken(getErrorMessage(err), target.bearerToken),
      inputJson: { mcpServerRef: target.url },
      name: 'mcp.connect_failed',
    });
    return null;
  }

  const instructions = client.getInstructions();
  const createServer = () => {
    const server = new McpServer(
      { name: 'auto-swe-relay', version: '1.0.0' },
      { capabilities: { tools: {} }, instructions }
    );
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { arguments: args, name } = request.params;
      if (!tools.some((t) => t.name === name)) {
        return failure(`The MCP tool '${name}' is not offered by this connection.`);
      }
      auditLog(
        `[mcp:audit] server=${url} tool=${name} args=${redactString(JSON.stringify(args ?? {}).slice(0, 2_000))} via=harness`
      );
      try {
        return (await withTimeout(
          client.callTool({ arguments: args, name }),
          callTimeoutMs,
          `MCP tool call '${name}'`
        )) as CallToolResult;
      } catch (err) {
        return failure(scrubToken(getErrorMessage(err), target.bearerToken));
      }
    });
    return server;
  };

  tracer?.addActivityEvent({
    durationMs: Date.now() - start,
    inputJson: { mcpServerRef: target.url },
    name: 'mcp.tools_loaded',
    outputJson: { count: tools.length, tools: tools.map((t) => t.name), via: 'harness' },
  });

  let closed: Promise<void> | undefined;
  return {
    callTimeoutMs,
    close: () => {
      closed ??= client.close().catch(() => undefined);
      return closed;
    },
    createServer,
    tools,
  };
}
