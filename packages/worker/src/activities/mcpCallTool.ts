import { loadMcpTools, sanitizeToolName } from '../agents/mcpTools.js';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { mcpUrlForConnection } from '../lib/config/mcpConnection.js';
import { assertRunMayUseConnection } from '../lib/connectionAccess.js';
import { mcpToolIsReadOnly } from '../lib/effectLedger.js';
import {
  raceActivityCancellation,
  throwIfActivityCancelled,
  withHeartbeat,
} from '../lib/execUtils.js';
import {
  assertApprovalSatisfied,
  findRecordedOutcome,
  mutationScope,
  notSent,
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
  // The core heartbeats while the call runs: an MCP call can take up to its 60 s timeout, which can
  // outlast the heartbeat timeout, and a heartbeat is how a cancellation reaches the activity.
  const { result } = await callMcpConnectionTool({
    connectionId: input.connectionRef,
    mode: 'auto',
    step: 'mcpNode',
    tool: input.tool,
    ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
  });
  return { result };
}

export type McpInvokeStep = 'mcpNode' | 'readSource' | 'writeOutcome' | 'runTool';

/**
 * How a call is governed.
 * - `readOnly`: refused (`notSent`, before the call and before any ledger write) unless the server
 *   annotated the tool `readOnlyHint: true`.
 * - `auto`: as the `mcp` node — a mutation unless the tool is annotated read-only.
 * - `mutating`: always a mutation (approval guard + outcome ledger), even for a read-only tool.
 */
export type McpInvokeMode = 'readOnly' | 'auto' | 'mutating';

export interface CallMcpConnectionToolInput {
  connectionId: string;
  tool: string;
  inputs?: unknown;
  /** The step's recording id; with a run id it keys the outcome ledger. */
  nodeId?: string;
  step: McpInvokeStep;
  mode: McpInvokeMode;
}

/**
 * The MCP tool-call core shared by the `mcp` node and the generic readSource / writeOutcome /
 * runTool steps. Same safety for all: template-team reach check, URL resolution, the connection's
 * tool allowlist before connecting, `loadMcpTools` (allowlist + result screening), the client closed
 * and the trace persisted in `finally`, cancellation raced against the call, and heartbeats while it
 * runs (the caller needs none of its own).
 *
 * Governance: the ledger is read before the approval guard; the guard and every connection check
 * run before the `performOnce` claim; refusals made by `mode` use `notSent`, so no PENDING row is
 * left. The ledger key exists only when `nodeId` and a run id are both present.
 *
 * `readOnly` in the result is the server's `readOnlyHint` for the tool, whatever `mode` governed.
 *
 * An MCP tool-level error (`isError: true` in the CallToolResult) is NOT inspected: it is returned
 * as `result` like any payload (and recorded in the ledger for a governed call). Only a thrown
 * error — transport failure, timeout, a screened result's block — fails the call. A caller that
 * wants to treat `isError` as failure must check `result` itself.
 */
export async function callMcpConnectionTool(
  input: CallMcpConnectionToolInput
): Promise<{ result: unknown; readOnly: boolean }> {
  return withHeartbeat('mcpCallTool', callMcpConnectionToolImpl(input));
}

async function callMcpConnectionToolImpl(
  input: CallMcpConnectionToolInput
): Promise<{ result: unknown; readOnly: boolean }> {
  const label = input.step === 'mcpNode' ? 'mcp node' : input.step;
  throwIfActivityCancelled();
  // The connection id is a literal in the spec, so nothing upstream authorized it:
  // without this a template can name another team's MCP server and spend its token.
  await assertRunMayUseConnection(input.connectionId, 'mcp');
  const target = await mcpUrlForConnection(input.connectionId);
  if (!target) {
    throw new Error(`${label}: connection '${input.connectionId}' is not an active mcp connection`);
  }
  const { url } = target;
  // The same allowlist `loadMcpTools` enforces when it binds, checked first so a refused tool
  // never costs a connection and the error names the cause rather than a missing tool.
  if (target.allowedTools && !target.allowedTools.includes(input.tool)) {
    throw new Error(
      `${label}: tool '${input.tool}' is not permitted by the connection's tool allowlist`
    );
  }

  const tracer = new AgentTracer();
  // The connection's allowlist applies to this step too: a tool outside it is never bound, so the
  // lookup below cannot find it.
  const loaded = await loadMcpTools(target, tracer);
  try {
    // Do not call an external tool for a run that was cancelled while connecting.
    throwIfActivityCancelled();
    const key = `mcp_${sanitizeToolName(input.tool)}`;
    const tool = loaded.tools[key];
    if (!tool?.execute) {
      throw new Error(
        `${label}: tool '${input.tool}' not found on ${url} (available: ${
          Object.keys(loaded.tools).join(', ') || 'none'
        })`
      );
    }
    // Governance is decided now, not before connecting: whether this call can
    // change anything is a property of the tool, and the tool list is what tells
    // us. A server that annotates a tool `readOnlyHint: true` gets a call that
    // is neither gated on an approval nor written to the outcome ledger — the
    // same treatment a connector read gets, unless `mode` is `mutating`. Everything else is a
    // mutation, and is refused when the run recorded a policy decision requiring an approval
    // that never came, and recorded so an activity retry returns the first
    // result instead of invoking the remote tool twice.
    const readOnly = mcpToolIsReadOnly(tool);
    if (input.mode === 'readOnly' && !readOnly) {
      throw notSent(
        `${label}: tool '${input.tool}' is not annotated read-only by the server, so it cannot be used to read a source`
      );
    }
    const governed = input.mode === 'mutating' || !readOnly;
    const scope = await mutationScope();
    const ledgerKey: OutcomeKey | null =
      governed && input.nodeId && scope.runId
        ? { connectionId: input.connectionId, nodeId: input.nodeId, runId: scope.runId }
        : null;
    // The ledger is consulted before the approval guard, as in `writeOutcome`
    // and `runTool`: the effect already happened, and returning what it produced
    // performs no second one. The guard does not depend on the ledger key: a
    // mutating call in a run without a `nodeId` is not recorded, but is still gated.
    if (ledgerKey) {
      const existing = await findRecordedOutcome<McpCallToolResult>(ledgerKey);
      if (existing) {
        return { readOnly, result: existing.result };
      }
      await assertApprovalSatisfied(ledgerKey.runId);
    } else if (governed && scope.runId) {
      await assertApprovalSatisfied(scope.runId);
    }

    // Mastra tool execute is `(input, context)`; @mastra/mcp reads every context
    // field with optional chaining (`context?.…`), so a direct call with just the
    // argument object is safe. The loaded tool is already wrapped with audit
    // logging + tracer recording + a per-call timeout.
    const execute = tool.execute as (
      input: Record<string, unknown>,
      context?: unknown
    ) => Promise<unknown>;
    const args = (input.inputs ?? {}) as Record<string, unknown>;
    // The MCP call takes no abort signal, so a cancel abandons it rather than
    // waiting out its timeout; the client is still closed in `finally`.
    // The ledger holds the activity's result, not the remote payload, so a retry returns exactly
    // what the first call returned. The claim is taken *before* the call, so a retry cannot act
    // twice on a response that was lost — and an MCP call is the one effect here with no
    // intermediate system to reconcile against.
    const call = async (): Promise<McpCallToolResult> => ({
      result: await raceActivityCancellation(execute(args)),
    });
    const done = ledgerKey
      ? await performOnce({ attempt: scope.attempt, dispatch: call, key: ledgerKey })
      : await call();
    return { readOnly, result: done.result };
  } finally {
    await loaded.close();
    await persistActivityTrace(tracer, 'mcp');
  }
}
