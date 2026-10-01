import { getSettingDefinition, resolveSettings } from '@auto-swe/shared/config';
import { IMPLEMENTER_TOOL_IDS, MCP_TOOL_KEY } from '@auto-swe/shared/workflow/stepRegistry';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Workspace } from '../activities/workspace.js';
import type { AgentTracer } from '../lib/agentTracer.js';
import {
  loadAgentSkills,
  loadAgentToolConfig,
  type ResolvedSkill,
} from '../lib/config/agentSkills.js';
import { resolveAgentMcpUrl } from '../lib/config/mcpConnection.js';
import type { ResolveCtx } from '../lib/config/types.js';
import { getModel, type LanguageModel } from '../lib/models.js';
import { isMcpToolEnabled, loadMcpTools, type McpToolRecord } from './mcpTools.js';
import { buildWorkspaceTools } from './workspaceTools.js';

/**
 * Creates a Mastra Implementer agent with MCP-style tools bound to a specific workspace container.
 * Each tool call is translated to a `docker exec` command inside the workspace.
 *
 * If `tracer` is provided every tool execution is recorded so callers can
 * persist the full tool-call sequence to `agent_traces` after generation.
 *
 * `tools`: string[] of enabled tool keys (from AgentToolConfig). null = all 4 tools.
 * `skills`: prompt-fragment skills to inject into the system prompt (in sortOrder).
 */
export type ImplementerToolId = (typeof IMPLEMENTER_TOOL_IDS)[number];
export { IMPLEMENTER_TOOL_IDS };

export interface ImplementerAgentOptions {
  /**
   * `Repository.mcpServerRef` for the repo being worked on — an http(s) URL
   * of a streamable-HTTP/SSE MCP server whose tools are added alongside the
   * built-in workspace tools. Defaults to disabled (callers must opt in).
   * Loading is additionally gated by the `'mcp'` pseudo-key in the effective
   * `AgentToolConfig` (see `isMcpToolEnabled`) and is failure-isolated: an
   * unreachable server logs `mcp.connect_failed` and the agent proceeds with
   * built-in tools only.
   */
  mcpServerRef?: string | null;
  /** Optional per-connection override of `loadMcpTools`'s list-timeout (default 15 s). */
  mcpListTimeoutMs?: number;
  /** Optional per-connection override of `loadMcpTools`'s per-call timeout (default 60 s). */
  mcpCallTimeoutMs?: number;
  /**
   * `workspace.maxToolOutputChars` (default 20,000), pre-resolved by the
   * caller. Threaded in rather than resolved here so it's a single settings
   * read per agent construction, not one per `bash`/`readFile`/`listDirectory`
   * call — `buildImplementerForActivity` resolves it alongside the tool/skill
   * config it already loads, and `evalHarness` resolves it for the same reason
   * an eval resolves the model. Omitting it falls back to the registry default,
   * which is only right for a caller with no scope to resolve against.
   */
  maxToolOutputChars?: number;
  /**
   * The Agent key whose model this agent binds — `implementer` by default, or
   * a sub-role persona (`ciFixer`, `reviewFixer`, `gateFixer`,
   * `mergeConflictResolver`), which reaches the implementer's model through
   * `inheritsModelFrom` unless it carries its own `modelSpec`.
   */
  agentKey?: string;
  /** Scope for the model lookup; merged over the ambient activity context. */
  resolveCtx?: ResolveCtx;
}

export async function createImplementerAgent(
  workspace: Workspace,
  tracer?: AgentTracer,
  tools?: string[] | null,
  skills?: ResolvedSkill[],
  options?: ImplementerAgentOptions,
  modelOverride?: LanguageModel
): Promise<{
  agent: Agent;
  mastra: Mastra;
  promptSuffix: string;
  /**
   * Present whenever an MCP server was contacted (including a connect that
   * returned zero tools) — callers MUST invoke it in a `finally` block to avoid
   * leaking the client connection.
   */
  closeMcp?: () => Promise<void>;
}> {
  // Resolved once, here, rather than inside a tool's `execute` — every
  // bash/readFile/listDirectory call in the session shares this value instead
  // of re-hitting the (cached, but non-zero-cost) settings resolver per call.
  const maxToolOutputChars =
    options?.maxToolOutputChars ??
    getSettingDefinition('workspace.maxToolOutputChars').defaultValue;
  const { bash, listDirectory, readFile, writeFile } = buildWorkspaceTools(
    workspace,
    tracer,
    maxToolOutputChars
  );

  // Build a name→skill index for the load_skill tool to look up full promptText.
  const resolvedSkills = skills ?? [];
  const skillsByName = new Map(resolvedSkills.map((s) => [s.name, s]));

  // Tool: Load the full prompt text for a skill on demand (progressive disclosure).
  // The agent sees a compact L1 menu (name + description) in the system prompt and
  // calls this tool to fetch the full reasoning guidance only when it decides to
  // engage that skill — avoiding token bloat from skills that aren't needed.
  const loadSkill = createTool({
    description:
      'Load the full guidance text for an available skill by name. ' +
      'Call this when you want to apply a specific skill from the skills menu.',
    execute: async ({ name }) => {
      const start = Date.now();
      const skill = skillsByName.get(name);
      if (!skill) {
        const result = {
          promptText: `Unknown skill: ${name}. Available: ${[...skillsByName.keys()].join(', ')}`,
        };
        tracer?.addToolCall({
          durationMs: Date.now() - start,
          inputJson: { name },
          outputJson: result,
          toolName: 'loadSkill',
        });
        return result;
      }
      const result = { promptText: skill.promptText };
      tracer?.addToolCall({
        durationMs: Date.now() - start,
        inputJson: { name },
        outputJson: result,
        toolName: 'loadSkill',
      });
      return result;
    },
    id: 'loadSkill',
    inputSchema: z.object({ name: z.string().describe('Skill name from the skills menu') }),
    outputSchema: z.object({ promptText: z.string() }),
  });

  // All available workspace tools keyed by toolKey.
  const workspaceTools = { bash, listDirectory, readFile, writeFile };

  // Filter workspace tools by the enabled tool keys when provided; null → use all 4 tools.
  const activeWorkspaceTools =
    tools && tools.length > 0
      ? Object.fromEntries(
          tools
            .filter((key) => key in workspaceTools)
            .map((key) => [key, workspaceTools[key as keyof typeof workspaceTools]])
        )
      : workspaceTools;

  // If every provided key was unrecognised, fall back to allTools to avoid
  // instantiating an agent with no tools.
  const resolvedWorkspaceTools =
    Object.keys(activeWorkspaceTools).length > 0 ? activeWorkspaceTools : workspaceTools;

  const hasSkills = resolvedSkills.length > 0;

  // Always include loadSkill when there are skills to load; this lets the agent
  // fetch full skill guidance on demand without pre-injecting all promptTexts.
  const resolvedActiveTools = hasSkills
    ? { ...resolvedWorkspaceTools, loadSkill }
    : resolvedWorkspaceTools;

  // MCP tools (Repository.mcpServerRef): opt-in via options, gated by the 'mcp'
  // pseudo-key in AgentToolConfig (a non-empty tool config must explicitly
  // include 'mcp'; no config = all tools = MCP allowed). loadMcpTools never
  // throws — connection failures leave the agent with built-in tools only.
  let mcpTools: McpToolRecord = {};
  let closeMcp: (() => Promise<void>) | undefined;
  if (options?.mcpServerRef && isMcpToolEnabled(tools)) {
    const loaded = await loadMcpTools(options.mcpServerRef, tracer, {
      callTimeoutMs: options.mcpCallTimeoutMs,
      listTimeoutMs: options.mcpListTimeoutMs,
    });
    // Always adopt the returned close — it is NOOP on failure/empty paths and
    // safe to call repeatedly. Capturing it only when tools>0 would leak the
    // live MCP client connection when a server connects but exposes zero tools.
    closeMcp = loaded.close;
    mcpTools = loaded.tools;
  }

  // L1 skill menu: compact name + description list injected into system prompt.
  // Agent calls load_skill(name) to get the full promptText when needed.
  const promptSuffix = hasSkills
    ? [
        '## Available Skills',
        'Use the `loadSkill` tool to load the full guidance for any skill before applying it.',
        '',
        ...resolvedSkills.map((s) => `- **${s.name}**: ${s.description || s.name}`),
      ].join('\n')
    : '';

  const implementerAgent = new Agent({
    id: 'implementer',
    // instructions is overridden per-call via system message; set to empty string
    // so the constructor does not inject stale static content.
    instructions: '',
    model:
      modelOverride ?? (await getModel(options?.agentKey ?? 'implementer', options?.resolveCtx)),
    name: 'implementer',
    // Built-in tool keys always win over MCP tool keys on collision —
    // a remote server must not be able to shadow bash/readFile/writeFile.
    tools: { ...mcpTools, ...resolvedActiveTools },
  });

  const mastra = new Mastra({
    agents: { implementer: implementerAgent },
  });

  return { agent: mastra.getAgent('implementer'), closeMcp, mastra, promptSuffix };
}

/**
 * The tool keys a sub-role persona (a fixer, the merge-conflict resolver) runs
 * with: its own `toolKeys` intersected with the implementer's. The personas
 * are the implementer under another name, so an admin who removes `bash` or
 * `mcp` from the implementer has removed it from every fix path too — a
 * persona can narrow the implementer's tools, never widen them.
 *
 * `null` and `[]` both mean "every tool" (see `createImplementerAgent` and
 * `isMcpToolEnabled`), and so does a list with no workspace tool in it. The
 * result is therefore computed on the expanded sets and written back as an
 * explicit list. An intersection with no workspace tool left cannot be
 * expressed — the builder would read it as all four — so it falls back to the
 * implementer's own workspace tools, which is never more than the implementer
 * itself gets.
 */
export function effectivePersonaToolKeys(
  persona: string[] | null,
  implementer: string[] | null
): string[] | null {
  const allowAll = (keys: string[] | null) => !keys || keys.length === 0;
  if (allowAll(persona) && allowAll(implementer)) {
    return null;
  }
  const expand = (keys: string[] | null) => {
    if (!keys || keys.length === 0) {
      return { mcp: true, workspace: [...IMPLEMENTER_TOOL_IDS] as string[] };
    }
    const workspace = IMPLEMENTER_TOOL_IDS.filter((id) => keys.includes(id)) as string[];
    return {
      mcp: keys.includes(MCP_TOOL_KEY),
      workspace: workspace.length > 0 ? workspace : [...IMPLEMENTER_TOOL_IDS],
    };
  };
  const p = expand(persona);
  const i = expand(implementer);
  const common = p.workspace.filter((id) => i.workspace.includes(id));
  const workspace = common.length > 0 ? common : i.workspace;
  return p.mcp && i.mcp ? [...workspace, MCP_TOOL_KEY] : workspace;
}

/**
 * Shared implementer setup for activities: loads the agent's tool config +
 * skills at the current scope (WORKFLOW_TEMPLATE → TEAM → GLOBAL), resolves its
 * optional MCP server URL, and builds the agent. Used by every implementer
 * activity so the load + MCP-binding lifecycle lives in one place. The caller
 * MUST invoke the returned `closeMcp` in a `finally` block.
 *
 * `agentKey` names the Agent row the session runs as. The fix paths and the
 * merge-conflict resolver pass their own persona key, so that row's tools, MCP
 * binding and model resolve — the model through `inheritsModelFrom` to the
 * implementer unless the persona overrides it. Skills are the persona's own;
 * a persona with no skills of its own gets the implementer's, since the seeded
 * personas carry none and would otherwise lose every coding skill.
 *
 * A persona's tools are bounded by the implementer's
 * (`effectivePersonaToolKeys`), and a persona with no MCP binding of its own
 * uses the implementer's — still subject to that bound, so it binds only when
 * both rows allow `mcp`.
 *
 * `maxSteps` is the `workspace.agentMaxSteps` step budget. Every
 * `agent.generate` on the returned agent MUST pass it: without it Mastra stops
 * a turn after 5 steps.
 */
export async function buildImplementerForActivity(
  workspace: Workspace,
  tracer: AgentTracer,
  ctx?: ResolveCtx,
  agentKey = 'implementer'
): Promise<{
  agent: Agent;
  promptSuffix: string;
  closeMcp?: () => Promise<void>;
  maxSteps: number;
  skills: ResolvedSkill[];
  toolKeys: string[] | null;
}> {
  const isPersona = agentKey !== 'implementer';
  const [ownToolKeys, implementerToolKeys, ownSkills, settings] = await Promise.all([
    loadAgentToolConfig(agentKey, ctx),
    isPersona ? loadAgentToolConfig('implementer', ctx) : null,
    loadAgentSkills(agentKey, ctx),
    resolveSettings(['workspace.maxToolOutputChars', 'workspace.agentMaxSteps'], ctx),
  ]);
  const toolKeys = isPersona
    ? effectivePersonaToolKeys(ownToolKeys, implementerToolKeys)
    : ownToolKeys;
  const skills =
    ownSkills.length === 0 && isPersona ? await loadAgentSkills('implementer', ctx) : ownSkills;
  const mcpTarget =
    (await resolveAgentMcpUrl(agentKey, ctx)) ??
    (isPersona ? await resolveAgentMcpUrl('implementer', ctx) : null);
  const { agent, promptSuffix, closeMcp } = await createImplementerAgent(
    workspace,
    tracer,
    toolKeys,
    skills,
    {
      agentKey,
      maxToolOutputChars: settings['workspace.maxToolOutputChars'],
      mcpCallTimeoutMs: mcpTarget?.callTimeoutMs,
      mcpListTimeoutMs: mcpTarget?.listTimeoutMs,
      mcpServerRef: mcpTarget?.url,
      resolveCtx: ctx,
    }
  );
  return {
    agent,
    closeMcp,
    maxSteps: settings['workspace.agentMaxSteps'],
    promptSuffix,
    skills,
    toolKeys,
  };
}
