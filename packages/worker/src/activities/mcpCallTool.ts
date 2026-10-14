import { loadMcpTools, sanitizeToolName } from '../agents/mcpTools.js';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { mcpUrlForConnection } from '../lib/config/mcpConnection.js';
import {
  raceActivityCancellation,
  throwIfActivityCancelled,
  withHeartbeat,
} from '../lib/execUtils.js';
import {
  assertApprovalSatisfied,
  findRecordedOutcome,
  mutationScope,
  type OutcomeKey,
  recordOutcome,
} from '../lib/externalWrite.js';

export interface McpCallToolInput {
  /** Id of an `mcp`-type Connection (its `config.url` is the server URL). */
  connectionRef: string;
  /** Name of the MCP tool to invoke on that server. */
  tool: string;
  /** Resolved tool arguments (from the node's `inputs` mapping). */
  inputs?: Record<string, unknown>;
  /**
   * The step's recording id (the interpreter's `dispatchKey`). Keys the outcome
   * ledger so a retried call returns the first result instead of invoking the
   * remote tool twice.
   */
  nodeId?: string;
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
  // Heartbeats while the whole activity runs: its LLM call can outlast the
  // heartbeat timeout, and a heartbeat is how a cancellation reaches it.
  return withHeartbeat('mcpCallTool', mcpCallToolImpl(input));
}

async function mcpCallToolImpl(input: McpCallToolInput): Promise<McpCallToolResult> {
  throwIfActivityCancelled();

  // An MCP tool's semantics belong to the remote server: we cannot tell a read
  // from a write, so every call is governed as a mutation — refused when the run
  // recorded a policy decision requiring an approval that never came, and
  // recorded against the outcome ledger so an activity retry returns the first
  // result rather than calling the remote tool twice.
  const scope = await mutationScope();
  const ledgerKey: OutcomeKey | null =
    input.nodeId && scope.runId
      ? { connectionId: input.connectionRef, nodeId: input.nodeId, runId: scope.runId }
      : null;
  if (scope.runId) {
    await assertApprovalSatisfied(scope.runId);
  }
  if (ledgerKey) {
    const existing = await findRecordedOutcome<McpCallToolResult>(ledgerKey);
    if (existing) {
      return existing;
    }
  }

  const target = await mcpUrlForConnection(input.connectionRef);
  if (!target) {
    throw new Error(
      `mcp node: connection '${input.connectionRef}' is not an active mcp connection`
    );
  }
  const { url, listTimeoutMs, callTimeoutMs, bearerToken, headers, allowPrivateNetwork } = target;

  const tracer = new AgentTracer();
  const loaded = await loadMcpTools(url, tracer, {
    allowPrivateNetwork,
    bearerToken,
    callTimeoutMs,
    headers,
    listTimeoutMs,
  });
  try {
    // Do not call an external tool for a run that was cancelled while connecting.
    throwIfActivityCancelled();
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
    // The MCP call takes no abort signal, so a cancel abandons it rather than
    // waiting out its timeout; the client is still closed in `finally`.
    const result = await raceActivityCancellation(execute(input.inputs ?? {}));
    if (ledgerKey) {
      await recordOutcome({ ...ledgerKey, attempt: scope.attempt, result });
    }
    return { result };
  } finally {
    await loaded.close();
    await persistActivityTrace(tracer, 'mcp');
  }
}
