import { loadMcpTools } from '../agents/mcpTools.js';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { parseAgentRef } from '../lib/config/agentRef.js';
import type { AgentTools } from '../lib/config/agentSpec.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { resolveAgentMcpUrl } from '../lib/config/mcpConnection.js';
import type { ModelBackedAgentKey } from '../lib/config/types.js';
import { runAgent } from './runAgent.js';

export interface RunAgentNodeInput {
  /** Library agent reference: `<key>` (float) or `<key>@<version>` (pin). */
  agentRef: string;
  /** Literal user message; when omitted, the resolved node inputs become the message (see {@link inputsToMessage}). */
  userMessage?: string;
  /** Resolved node inputs (used as the message payload when userMessage is absent). */
  inputs?: Record<string, unknown>;
  /** OTel span + cost-attribution name. */
  spanName?: string;
  /** Per-node system-prompt override (wins over the Agent's own prompt). */
  systemPrompt?: string;
  /**
   * Channel assistant (Phase A): SlackChannel.id the run originated from. When
   * set, the agent resolves the CHANNEL config tier (per-channel tools/MCP/model)
   * — `currentRequestContext()` can't derive it (a channel-task run has no
   * `ActiveWorkflow` row), so the workflow threads it from the run request.
   */
  channelId?: string;
  /**
   * Channel assistant (Phase C): soft steering guidance the interpreter drained
   * from the `steer` signal buffer before invoking this agent node. When present,
   * it is prepended to the user message as a clearly-labeled block so the agent
   * incorporates the new direction. SOFT semantics: this only reaches the NEXT
   * agent node after the signal arrived — an already-running node is not preempted.
   */
  steering?: string[];
}

export interface RunAgentNodeResult {
  text?: string;
  object?: unknown;
}

/**
 * Temporal activity backing the declarative `agent` workflow node (P2). Resolves
 * the `agentRef` into an {@link AgentSpec} through the P1 Agent library
 * (`resolveAgentSpec` → `resolveAgent`, honoring the run-start version snapshot
 * and any explicit `@version` pin) and runs it via the P0 `runAgent` loop.
 *
 * No workspace tools are attached to a generic agent node, but MCP tools bind
 * when the resolved Agent enables them (`'mcp'` toolKey + `mcpConnectionId`) —
 * the generic counterpart to the implementer's `buildImplementerForActivity`.
 */
export async function runAgentNode(input: RunAgentNodeInput): Promise<RunAgentNodeResult> {
  const baseCtx = await currentRequestContext();
  // Phase A: a channel-task run carries its originating channelId on the request
  // (not derivable from `currentRequestContext`, which keys on ActiveWorkflow).
  // Thread it in so the CHANNEL config tier fires for per-channel tools/MCP/model.
  const ctx = input.channelId ? { ...baseCtx, channelId: input.channelId } : baseCtx;
  const { key, version } = parseAgentRef(input.agentRef);

  // An explicit `@version` pin overrides the run-start snapshot for this key.
  const resolveCtx =
    version !== undefined
      ? { ...ctx, agentVersions: { ...(ctx.agentVersions ?? {}), [key]: version } }
      : ctx;

  // `key` is free-form (a template-declared agent key); the resolver input is
  // typed to the SWE role union. basePrompt is empty — the Agent supplies its
  // own system prompt (custom agents set one; sub-roles inherit).
  const spec = await resolveAgentSpec(
    { agentKey: key as ModelBackedAgentKey, basePrompt: '', promptOverride: input.systemPrompt },
    resolveCtx
  );

  // P2/WS3: bind MCP tools when the Agent enables them; closed in finally.
  // loadMcpTools is failure-isolated, so a bad server degrades to no tools.
  const tracer = new AgentTracer();
  const mcpTarget = await resolveAgentMcpUrl(key, resolveCtx);
  let closeMcp: (() => Promise<void>) | undefined;
  if (mcpTarget) {
    const loaded = await loadMcpTools(mcpTarget.url, tracer, {
      callTimeoutMs: mcpTarget.callTimeoutMs,
      listTimeoutMs: mcpTarget.listTimeoutMs,
    });
    closeMcp = loaded.close;
    // Built-in/spec tools win over MCP tools on key collision.
    spec.tools = { ...loaded.tools, ...spec.tools } as AgentTools;
  }

  try {
    const baseMessage = input.userMessage ?? inputsToMessage(input.inputs);
    const userMessage = prependSteering(baseMessage, input.steering);
    const result = await runAgent(spec, userMessage, {
      spanName: input.spanName ?? 'llm.agent_node',
    });
    return { object: result.object, text: result.text };
  } finally {
    await closeMcp?.();
    await persistActivityTrace(tracer, key);
  }
}

/**
 * Turn the resolved node inputs into the agent's user message when no literal
 * `userMessage` was set. A SINGLE string input (e.g. the Channel Task spec's
 * `task` description) is sent as the plain string — sending `{"task":"…"}` as
 * JSON degrades prompt quality and pollutes any prepended steering block.
 * Anything else (multiple inputs, non-string values) keeps the structured JSON
 * payload so multi-input agent nodes still get the full object.
 */
function inputsToMessage(inputs: Record<string, unknown> | undefined): string {
  if (!inputs) {
    return '{}';
  }
  const values = Object.values(inputs);
  if (values.length === 1 && typeof values[0] === 'string') {
    return values[0];
  }
  return JSON.stringify(inputs);
}

/**
 * Append the steering messages as a labeled block after the base user message so
 * the agent treats them as new direction to incorporate. Empty/absent steering
 * leaves the message untouched.
 */
function prependSteering(message: string, steering: string[] | undefined): string {
  if (!steering || steering.length === 0) {
    return message;
  }
  const block = steering.map((s) => `- ${s}`).join('\n');
  return `${message}\n\n[Steering update from the channel — incorporate this]:\n${block}`;
}
