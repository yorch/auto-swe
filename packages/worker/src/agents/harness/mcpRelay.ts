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
import { mcpToolIsReadOnly, recordEffect } from '../../lib/effectLedger.js';
import { getErrorMessage } from '../../lib/errors.js';
import { screenMcpResult } from '../mcpScreen.js';
import {
  bearerFetch,
  guardedMcpFetch,
  type McpTracer,
  originScopedFetch,
  parseMcpServerRef,
  scrubToken,
  selectAllowedMcpTools,
  withTimeout,
} from '../mcpTools.js';
import { neutraliseThirdPartyTools } from './thirdPartyToolText.js';

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
  /**
   * Run one call on the remote server, for a harness whose loop runs in the
   * worker and takes the tools directly. Audit-logged like a call through the
   * server; a failure comes back as an error result, never a throw.
   */
  callTool(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult>;
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
  tracer?: McpTracer,
  options: {
    /**
     * Applied after the connection's allowlist: a tool it refuses is neither offered nor
     * callable. For a caller that must fit the tool names into a naming rule of its own.
     */
    acceptTool?: (name: string) => boolean;
    /**
     * For a relay that is not the Agent's own connection (a plugin's mapped server): its endpoint
     * is not the audience's to read, and the server's text is not the operator's. The audit log
     * names `label` in place of the URL, `scrub` is applied to every error the model or a trace
     * sees, and the server's own `instructions` are not offered to the harness at all: they are
     * third-party text from a server the plugin's author chose, and would otherwise go into the
     * system prompt unscreened. The tools' descriptions and schema text are neutralised
     * ({@link neutraliseThirdPartyTools}): stripped of control characters, length-capped and
     * screened for injection.
     */
    thirdParty?: { label: string; scrub: (text: string) => string };
  } = {}
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
  let skipped: string[];
  try {
    client = await connect(url, fetch, listTimeoutMs);
    const listed = await withTimeout(
      listAllTools(client),
      listTimeoutMs,
      `MCP tool listing from ${url}`
    );
    // The connection's allowlist applies here, before anything is offered: a tool outside it is
    // absent from the list the harness sees, and `callTool` refuses any name that is not in it.
    const split = selectAllowedMcpTools(
      listed.map((t) => t.name),
      target.allowedTools
    );
    const kept = new Set(split.kept);
    const offered = listed.filter(
      (t) => kept.has(t.name) && (options.acceptTool?.(t.name) ?? true)
    );
    // A plugin's server is third-party: its tool text is neutralised before the harness sees it.
    tools = options.thirdParty ? await neutraliseThirdPartyTools(offered) : offered;
    skipped = split.skipped;
  } catch (err) {
    tracer?.addActivityEvent({
      durationMs: Date.now() - start,
      error: scrubToken(getErrorMessage(err), target.bearerToken),
      inputJson: { mcpServerRef: target.url },
      name: 'mcp.connect_failed',
    });
    return null;
  }

  const instructions = options.thirdParty ? undefined : client.getInstructions();
  const scrubbed = (text: string) => (options.thirdParty ? options.thirdParty.scrub(text) : text);
  const callTool = async (
    name: string,
    args: Record<string, unknown> | undefined
  ): Promise<CallToolResult> => {
    const offered = tools.find((t) => t.name === name);
    if (!offered) {
      return failure(`The MCP tool '${name}' is not offered by this connection.`);
    }
    const guarded = target.approval;
    if (guarded) {
      // An orchestration's run: a write waits for the launcher, and a refusal is an error result.
      const outcome = await guarded.run(
        { annotations: offered.annotations, args, toolName: name },
        () => invoke(offered, name, args)
      );
      return outcome.ran ? outcome.value : failure(scrubbed(outcome.message));
    }
    return invoke(offered, name, args);
  };
  const invoke = async (
    offered: Tool,
    name: string,
    args: Record<string, unknown> | undefined
  ): Promise<CallToolResult> => {
    // Reads are not effects: only a call the server did not declare read-only is recorded.
    const record = (status: 'DONE' | 'FAILED', error?: unknown) =>
      mcpToolIsReadOnly(offered)
        ? Promise.resolve()
        : recordEffect({
            action: name,
            error,
            input: args,
            kind: 'MCP_TOOL',
            status,
            target: name,
            via: 'harness_relay',
          });
    auditLog(
      `[mcp:audit] server=${options.thirdParty?.label ?? url} tool=${name} args=${redactString(JSON.stringify(args ?? {}).slice(0, 2_000))} via=harness`
    );
    try {
      const result = (await withTimeout(
        client.callTool({ arguments: args, name }),
        callTimeoutMs,
        `MCP tool call '${name}'`
      )) as CallToolResult;
      await record(
        result.isError ? 'FAILED' : 'DONE',
        result.isError ? 'tool reported an error' : undefined
      );
      if (target.scanResults !== true && target.approval === undefined) {
        return result;
      }
      const screened = await screenMcpResult(result, name, tracer);
      return screened.blocked
        ? failure(scrubbed(screened.message))
        : (screened.result as CallToolResult);
    } catch (err) {
      const message = scrubbed(scrubToken(getErrorMessage(err), target.bearerToken));
      await record('FAILED', message);
      return failure(message);
    }
  };
  const createServer = () => {
    const server = new McpServer(
      { name: 'auto-swe-relay', version: '1.0.0' },
      { capabilities: { tools: {} }, instructions }
    );
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.server.setRequestHandler(CallToolRequestSchema, async (request) =>
      callTool(request.params.name, request.params.arguments)
    );
    return server;
  };

  if (skipped.length > 0) {
    tracer?.addActivityEvent({
      inputJson: { mcpServerRef: target.url },
      name: 'mcp.tools_skipped',
      outputJson: { reason: 'not_allowlisted', skipped, via: 'harness' },
    });
  }
  tracer?.addActivityEvent({
    durationMs: Date.now() - start,
    inputJson: { mcpServerRef: target.url },
    name: 'mcp.tools_loaded',
    outputJson: { count: tools.length, tools: tools.map((t) => t.name), via: 'harness' },
  });

  let closed: Promise<void> | undefined;
  return {
    callTimeoutMs,
    callTool,
    close: () => {
      closed ??= client.close().catch(() => undefined);
      return closed;
    },
    createServer,
    tools,
  };
}
