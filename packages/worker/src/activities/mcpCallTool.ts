import { loadMcpTools, sanitizeToolName } from '../agents/mcpTools.js';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { mcpUrlForConnection } from '../lib/config/mcpConnection.js';

export interface McpCallToolInput {
  /** Id of an `mcp`-type Connection (its `config.url` is the server URL). */
  connectionRef: string;
  /** Name of the MCP tool to invoke on that server. */
  tool: string;
  /** Resolved tool arguments (from the node's `inputs` mapping). */
  inputs?: Record<string, unknown>;
  /** OTel span / attribution name. */
  spanName?: string;
}

export interface McpCallToolResult {
  result: unknown;
}

/**
 * Temporal activity backing the declarative `mcp` workflow node (P2/WS4). Resolves
 * the `mcp` Connection's URL, loads its tools, invokes the named one with the
 * mapped inputs, and returns its result (recorded at `nodes.<id>.output.result`).
 *
 * Unlike the best-effort MCP binding on agents, this is an explicit step: a
 * missing connection/tool or a tool error throws so the node's retry/onFail
 * policy governs it. The MCP client is always disconnected in `finally`.
 */
export async function mcpCallTool(input: McpCallToolInput): Promise<McpCallToolResult> {
  const url = await mcpUrlForConnection(input.connectionRef);
  if (!url) {
    throw new Error(
      `mcp node: connection '${input.connectionRef}' is not an active mcp connection`
    );
  }

  const tracer = new AgentTracer();
  const loaded = await loadMcpTools(url, tracer);
  try {
    const key = `mcp_${sanitizeToolName(input.tool)}`;
    const tool = loaded.tools[key];
    if (!tool?.execute) {
      throw new Error(
        `mcp node: tool '${input.tool}' not found on ${url} (available: ${
          Object.keys(loaded.tools).join(', ') || 'none'
        })`
      );
    }
    // Mastra tool execute is `(input, context)`; @mastra/mcp reads every context
    // field with optional chaining (`context?.…`), so a direct call with just the
    // argument object is safe. The loaded tool is already wrapped with audit
    // logging + tracer recording + a per-call timeout.
    const execute = tool.execute as (
      input: Record<string, unknown>,
      context?: unknown
    ) => Promise<unknown>;
    const result = await execute(input.inputs ?? {});
    return { result };
  } finally {
    await loaded.close();
    await persistActivityTrace(tracer, 'mcp');
  }
}
