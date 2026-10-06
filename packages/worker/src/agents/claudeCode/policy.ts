import type { HarnessCapabilities } from '../harness/adapter.js';
import {
  type CanonicalToolCall,
  canonicalToolsGranting,
  decideCanonicalCall,
  deny,
  nativeTools,
  nativeToolsFor,
  type ToolDecision,
  type ToolVocabulary,
} from '../harness/policy.js';

export type { ToolDecision } from '../harness/policy.js';

/**
 * The harness tools a workspace run may use — the same capability as the four
 * Mastra workspace tools (read, write, list, shell), under Claude Code's names.
 * Everything else the harness knows (web fetch, sub-agents, plugins' tools) is
 * denied until a profile grants it deliberately.
 */
export const HARNESS_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'] as const;

export type HarnessTool = (typeof HARNESS_TOOLS)[number];

/**
 * The SDK's `PreToolUse` hook is a callback in the worker that the harness
 * waits on before every tool call; the SDK's flag and policy settings layers,
 * passed over the same pipe, make a repository's settings unable to grant a
 * call, and a hook that times out falls back to a deny (`runtime.ts`).
 */
export const CLAUDE_CODE_CAPABILITIES: HarnessCapabilities = {
  enforcesPerCallPolicyInWorker: true,
};

/** Claude Code's tools in the canonical vocabulary (`harness/policy.ts`). */
export const CLAUDE_CODE_TOOLS: ToolVocabulary<HarnessTool> = {
  canonical: {
    Bash: 'shell',
    Edit: 'write',
    Glob: 'search',
    Grep: 'search',
    Read: 'read',
    Write: 'write',
  },
  tools: HARNESS_TOOLS,
};

/**
 * The harness tools a resolved Agent's `toolKeys` grant, read exactly as the
 * Mastra implementer reads them: `readFile` and `listDirectory` grant `Read`,
 * `Glob` and `Grep`; `writeFile` grants `Write` and `Edit`; `bash` grants
 * `Bash`; `null`, `[]`, or a list naming no workspace tool grants all six.
 */
export function harnessToolsFor(toolKeys: readonly string[] | null | undefined): HarnessTool[] {
  return nativeToolsFor(CLAUDE_CODE_TOOLS, toolKeys);
}

/**
 * The harness tools that stand in for exactly these workspace tool keys, with
 * no default: an empty grant is no tools. For a caller that has already decided
 * which workspace tools an agent gets (an agent run, `grantedWorkspaceToolIds`).
 */
export function harnessToolsGranting(keys: readonly string[]): HarnessTool[] {
  return nativeTools(CLAUDE_CODE_TOOLS, canonicalToolsGranting(keys));
}

export interface PolicyContext {
  containerId: string;
  /** The repository checkout — the only place the harness may write. */
  cwd: string;
  /** The harness's own home inside the container; its tool-output files live under `.claude`. */
  home: string;
  /**
   * The harness loads the repository's `.claude` settings and `CLAUDE.md`, so
   * the agent may not rewrite them: what it wrote would govern the next turn.
   */
  projectConfigLoaded: boolean;
  /** The harness tools the Agent's `toolKeys` grant ({@link harnessToolsFor}). */
  tools: readonly HarnessTool[];
}

/**
 * The harness's own configuration inside the checkout: `.claude/` (settings,
 * hooks, commands, agents), `CLAUDE.md` and `CLAUDE.local.md` at any depth, and
 * the root `.mcp.json`. The harness reads them when a turn starts, so a write
 * here would change what the next turn runs under.
 */
function isHarnessConfig(rel: string): boolean {
  const segments = rel.toLowerCase().split('/');
  const base = segments.at(-1) ?? '';
  return (
    segments.includes('.claude') ||
    base === 'claude.md' ||
    base === 'claude.local.md' ||
    rel.toLowerCase() === '.mcp.json'
  );
}

/** One Claude Code tool call in the canonical vocabulary. */
function toCanonical(tool: HarnessTool, input: Record<string, unknown>): CanonicalToolCall {
  switch (tool) {
    case 'Bash':
      return { command: input.command, tool: 'shell' };
    case 'Write':
      return { content: input.content, path: input.file_path, tool: 'write' };
    // `Edit` carries a fragment, so the content check sees `new_string`, not the whole file.
    case 'Edit':
      return { content: input.new_string, path: input.file_path, tool: 'write' };
    case 'Read':
      return { path: input.file_path, tool: 'read' };
    case 'Glob':
      return { path: input.path, pattern: input.pattern, tool: 'search' };
    case 'Grep':
      return { path: input.path, pattern: input.glob, tool: 'search' };
  }
}

/**
 * The worker's verdict on one Claude Code tool call, made before the harness
 * runs it: the call is translated into the canonical vocabulary and decided by
 * `decideCanonicalCall`, which applies the scanners that guard the Mastra tools.
 *
 * What is Claude Code's own: a tool the Agent's `toolKeys` do not grant is
 * refused here as well as left out of the harness's tool list; the harness's
 * `.claude` directory under its home is readable (staged prompts and offloaded
 * tool output live there); and its configuration in the checkout is protected
 * while the run loads it ({@link isHarnessConfig}). Any tool outside
 * {@link HARNESS_TOOLS} is refused.
 */
export async function decideToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: PolicyContext,
  harnessCwd?: string
): Promise<ToolDecision> {
  if (!(HARNESS_TOOLS as readonly string[]).includes(toolName)) {
    return deny(`The ${toolName} tool is not available in this workspace.`);
  }
  const tool = toolName as HarnessTool;
  if (!ctx.tools.includes(tool)) {
    return deny(`The ${toolName} tool is not enabled for this agent.`);
  }
  return decideCanonicalCall(
    toolName,
    toCanonical(tool, input),
    {
      containerId: ctx.containerId,
      cwd: ctx.cwd,
      extraReadRoots: [`${ctx.home}/.claude`],
      protectedConfig: ctx.projectConfigLoaded
        ? { label: 'Claude Code', matches: isHarnessConfig }
        : undefined,
    },
    harnessCwd
  );
}
