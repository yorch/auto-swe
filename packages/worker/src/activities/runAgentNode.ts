import { loadMcpTools } from '../agents/mcpTools.js';
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
  /** Literal user message; when omitted, the resolved node inputs are sent as JSON. */
  userMessage?: string;
  /** Resolved node inputs (used as the message payload when userMessage is absent). */
  inputs?: Record<string, unknown>;
  /** OTel span + cost-attribution name. */
  spanName?: string;
  /** Per-node system-prompt override (wins over the Agent's own prompt). */
  systemPrompt?: string;
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
  const ctx = await currentRequestContext();
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
  const mcpServerRef = await resolveAgentMcpUrl(key, resolveCtx);
  let closeMcp: (() => Promise<void>) | undefined;
  if (mcpServerRef) {
    const loaded = await loadMcpTools(mcpServerRef);
    closeMcp = loaded.close;
    // Built-in/spec tools win over MCP tools on key collision.
    spec.tools = { ...loaded.tools, ...spec.tools } as AgentTools;
  }

  try {
    const userMessage = input.userMessage ?? JSON.stringify(input.inputs ?? {});
    const result = await runAgent(spec, userMessage, {
      spanName: input.spanName ?? 'llm.agent_node',
    });
    return { object: result.object, text: result.text };
  } finally {
    await closeMcp?.();
  }
}
