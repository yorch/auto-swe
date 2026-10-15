import { loadMcpTools, sanitizeToolName } from '../agents/mcpTools.js';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { mcpUrlForConnection } from '../lib/config/mcpConnection.js';
import { assertRunMayUseConnection } from '../lib/connectionAccess.js';
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
  performOnce,
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

/**
 * Whether the remote server declared this tool as read-only (the MCP
 * `readOnlyHint` annotation). Mastra copies the server's annotations onto the
 * tool it builds (`@mastra/mcp`), so this is the protocol's own signal rather
 * than a guess from the name.
 *
 * Absent or false means unknown, and an unknown tool is governed as a mutation:
 * the annotation is the only thing that can tell us a call has no effect, and
 * `readOnlyHint` defaults to false in the protocol.
 */
function mcpToolIsReadOnly(tool: unknown): boolean {
  const annotations = (tool as { mcp?: { annotations?: { readOnlyHint?: boolean } } } | undefined)
    ?.mcp?.annotations;
  return annotations?.readOnlyHint === true;
}

async function mcpCallToolImpl(input: McpCallToolInput): Promise<McpCallToolResult> {
  throwIfActivityCancelled();
  // The `connectionRef` is a literal in the spec, so nothing upstream authorized it:
  // without this a template can name another team's MCP server and spend its token.
  await assertRunMayUseConnection(input.connectionRef, 'mcp');
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
    // Governance is decided now, not before connecting: whether this call can
    // change anything is a property of the tool, and the tool list is what tells
    // us. A server that annotates a tool `readOnlyHint: true` gets a call that
    // is neither gated on an approval nor written to the outcome ledger — the
    // same treatment a connector read gets. Everything else is a mutation, and
    // is refused when the run recorded a policy decision requiring an approval
    // that never came, and recorded so an activity retry returns the first
    // result instead of invoking the remote tool twice.
    const readOnly = mcpToolIsReadOnly(tool);
    const scope = await mutationScope();
    const ledgerKey: OutcomeKey | null =
      !readOnly && input.nodeId && scope.runId
        ? { connectionId: input.connectionRef, nodeId: input.nodeId, runId: scope.runId }
        : null;
    // The ledger is consulted before the approval guard, as in `writeOutcome`
    // and `runTool`: the effect already happened, and returning what it produced
    // performs no second one.
    if (ledgerKey) {
      const existing = await findRecordedOutcome<McpCallToolResult>(ledgerKey);
      if (existing) {
        return existing;
      }
      if (scope.runId) {
        await assertApprovalSatisfied(scope.runId);
      }
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
    // The ledger holds the activity's result, not the remote payload, so a retry returns exactly
    // what the first call returned. The claim is taken *before* the call, so a retry cannot act
    // twice on a response that was lost — and an MCP call is the one effect here with no
    // intermediate system to reconcile against.
    const call = async (): Promise<McpCallToolResult> => ({
      result: await raceActivityCancellation(execute(input.inputs ?? {})),
    });
    return ledgerKey
      ? await performOnce({ attempt: scope.attempt, dispatch: call, key: ledgerKey })
      : await call();
  } finally {
    await loaded.close();
    await persistActivityTrace(tracer, 'mcp');
  }
}
