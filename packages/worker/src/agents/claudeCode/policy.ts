import path from 'node:path';
import type { ProfileTool } from '@auto-swe/shared/lib/harnessProfile';
import { canonicalizeShellForScan } from '@auto-swe/shared/lib/regexSafety';
import { SECURITY_TRACE_ERRORS } from '@auto-swe/shared/lib/scannerCache';
import { extractShellWriteTargets } from '../../lib/shellCommandScanner.js';
import { HARNESS_DIR, HARNESS_HOME, type HarnessCapabilities } from '../harness/adapter.js';
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
 * A harness tool the worker allows: one of {@link HARNESS_TOOLS}, or a built-in
 * an approved profile grants ({@link PROFILE_TOOLS}: `Skill` and `Agent`).
 * Nothing else is ever grantable; `WebFetch` and `WebSearch` stay refused even
 * when a plugin's sub-agent definition lists them.
 */
export type ClaudeCodeTool = HarnessTool | ProfileTool | typeof ASK_TOOL;

/**
 * The harness's question tool. Offered only to a run that can pause
 * ({@link toolsWithPause}); otherwise it is refused like any tool outside the
 * vocabulary. The call itself is answered by the runtime's hook, which records
 * the questions and ends the turn; the policy only lets it reach the hook.
 */
export const ASK_TOOL = 'AskUserQuestion';

/**
 * The built-ins a profile may grant. Spelled here rather than imported so the
 * policy stays light; the type check below fails if the manifest allows a tool
 * this list lacks.
 */
const PROFILE_TOOLS = ['Skill', 'Agent'] as const satisfies readonly ProfileTool[];
type EveryProfileToolListed = ProfileTool extends (typeof PROFILE_TOOLS)[number] ? true : never;
const everyProfileToolListed: EveryProfileToolListed = true;
void everyProfileToolListed;

const isProfileTool = (tool: string): tool is ProfileTool =>
  (PROFILE_TOOLS as readonly string[]).includes(tool);

/**
 * `tools` with the built-ins a profile grants added. Only {@link PROFILE_TOOLS}
 * are ever added, whatever `granted` holds. The result is the SDK's `tools`
 * list and the policy's allowlist, so the two cannot disagree.
 */
export function toolsWithProfile(
  tools: readonly HarnessTool[],
  granted: readonly string[] | undefined
): ClaudeCodeTool[] {
  const extra = PROFILE_TOOLS.filter((tool) => granted?.includes(tool));
  return [...tools, ...extra];
}

/** `tools` with the question tool added when the run can pause. */
export function toolsWithPause(
  tools: readonly ClaudeCodeTool[],
  allowPause: boolean | undefined
): ClaudeCodeTool[] {
  return allowPause ? [...tools, ASK_TOOL] : [...tools];
}

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

/** The in-process MCP server an Agent's MCP connection is relayed through. */
export const MCP_RELAY_SERVER = 'connection';
export const BROWSER_MCP_SERVER = 'browser';
export const BROWSER_RELAYED_TOOL_NAMES = [
  'browser_start_app',
  'browser_navigate',
  'browser_click',
  'browser_fill',
  'browser_press',
  'browser_select',
  'browser_wait',
  'browser_snapshot',
  'browser_screenshot',
  'browser_console',
].map((name) => `mcp__${BROWSER_MCP_SERVER}__${name}`);

/** The name the harness calls a relayed MCP tool by: `mcp__<server>__<tool>`. */
export function relayedToolName(tool: string): string {
  return `mcp__${MCP_RELAY_SERVER}__${tool}`;
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
  /**
   * The harness tools the Agent's `toolKeys` grant ({@link harnessToolsFor}),
   * plus the built-ins its profile grants ({@link toolsWithProfile}).
   */
  tools: readonly ClaudeCodeTool[];
  /**
   * Where the materialized profile lives in the container. Readable (plugins
   * must be); like the rest of the harness directory it is never writable.
   */
  profileDir?: string;
  /** The skills and commands the profile's plugins declare, plugin-qualified ({@link profileSkillNames}). */
  profileSkills?: ReadonlySet<string>;
  /**
   * The relayed MCP tools, by the name the harness calls them
   * ({@link relayedToolName}). Each runs in the worker, against the Agent's MCP
   * connection, and is audit-logged there; nothing about it runs in the container.
   */
  mcpTools?: readonly string[];
  browserTools?: readonly string[];
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

/**
 * Whether `p` (absolute, or relative to the call's directory) is the harness
 * directory (`/workspace/.harness`: the binary, its home, the materialized
 * profile) or anything under it.
 */
function underHarnessDir(p: string, cwd: string): boolean {
  const resolved = path.posix.resolve(cwd, p.replace(/^~(?=\/|$)/, HARNESS_HOME));
  return resolved === HARNESS_DIR || resolved.startsWith(`${HARNESS_DIR}/`);
}

/** Commands that change files or run code that can; with `>`, the ways a command writes. */
const MUTATING_COMMAND =
  /(?:^|[^\w./-])(?:rm|mv|cp|chmod|chown|chgrp|ln|tee|dd|truncate|install|touch|mkdir|rmdir|sed|awk|perl|python3?|node|ruby|sh|bash|patch|rsync|tar|unzip|setfacl|shred|truncate)\b|>/;

/**
 * A tripwire over the text of a shell command: does it appear to write under
 * the harness directory? Write targets the scanner can extract are resolved
 * against the harness's directory; and a command that names `.harness` at all
 * while using anything that changes files is refused (a variable or an
 * interpreter can spell a path the extraction cannot see). It raises the
 * floor; an agent with arbitrary shell can still change files in its own
 * container, which is why the profile is written again at the start of every turn.
 */
export function shellWritesHarnessDir(command: string, cwd: string): boolean {
  const targets = [
    ...extractShellWriteTargets(command),
    ...extractShellWriteTargets(canonicalizeShellForScan(command)),
  ];
  if (targets.some((target) => underHarnessDir(target, cwd))) {
    return true;
  }
  return /\.harness(?![\w-])/.test(command) && MUTATING_COMMAND.test(command);
}

/**
 * One Claude Code tool call in the canonical vocabulary, or null for a tool
 * with no file or shell capability of its own: `Skill` loads a skill's text
 * and `Agent` starts a sub-agent, whose own tool calls are decided one by one
 * ({@link decideProfileTool}).
 */
function toCanonical(
  tool: ClaudeCodeTool,
  input: Record<string, unknown>
): CanonicalToolCall | null {
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
    case 'Skill':
    case 'Agent':
    case 'AskUserQuestion':
      return null;
  }
}

/**
 * A profile-granted tool.
 *
 * `Agent` must run in the foreground, in the default mode, as the sub-agent
 * the profile or the harness names, on the model the session already uses: an
 * `isolation`, a looser `mode`, a `model` override (the model proxy meters only
 * the model it is asked for), a `name` or `team_name` (they address or detach
 * it), and a background run (`run_in_background` defaults to true in the SDK, so
 * it must be stated false) are refused. The sub-agent's own tool calls reach
 * the same `PreToolUse` hook (the hook input carries an `agent_id`) and are
 * decided by {@link decideToolCall} like any other call.
 *
 * `Skill` runs only a skill or command the profile's own plugins declare, in its
 * plugin-qualified spelling ({@link profileSkillNames}). Anything else (a bundled
 * skill, a repository's `.claude/commands/*.md`, whose `!` lines run shell
 * commands when the command is invoked, or a repository skill) is refused: it
 * would run text the worker never reviewed outside the Bash policy.
 */
function decideProfileTool(
  tool: ProfileTool,
  input: Record<string, unknown>,
  ctx: PolicyContext
): ToolDecision {
  if (tool === 'Skill') {
    const skill = input.skill;
    if (typeof skill !== 'string' || !ctx.profileSkills?.has(skill)) {
      return deny(
        'The Skill tool may run only a skill or command declared by this agent\u2019s profile, spelled <plugin>:<name>.'
      );
    }
    return { allow: true };
  }
  if (input.isolation !== undefined) {
    return deny('The Agent tool may not use isolation in this workspace.');
  }
  if (input.mode !== undefined && input.mode !== 'default') {
    return deny('The Agent tool may not change the permission mode in this workspace.');
  }
  if (input.model !== undefined) {
    return deny('The Agent tool may not override the model in this workspace.');
  }
  if (input.name !== undefined || input.team_name !== undefined) {
    return deny('The Agent tool may not name or address a sub-agent in this workspace.');
  }
  if (input.run_in_background !== false) {
    return deny(
      'The Agent tool must run in the foreground in this workspace: set run_in_background to false.'
    );
  }
  return { allow: true };
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
 * while the run loads it ({@link isHarnessConfig}). A relayed MCP tool
 * (`ctx.mcpTools`) is allowed: it runs in the worker, not the container. Any
 * other tool outside {@link HARNESS_TOOLS} is refused.
 */
export async function decideToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: PolicyContext,
  harnessCwd?: string
): Promise<ToolDecision> {
  if (ctx.mcpTools?.includes(toolName)) {
    return { allow: true };
  }
  if (ctx.browserTools?.includes(toolName)) {
    return { allow: true };
  }
  if (
    !(HARNESS_TOOLS as readonly string[]).includes(toolName) &&
    !isProfileTool(toolName) &&
    toolName !== ASK_TOOL
  ) {
    return deny(`The ${toolName} tool is not available in this workspace.`);
  }
  const tool = toolName as ClaudeCodeTool;
  if (toolName === ASK_TOOL && !ctx.tools.includes(ASK_TOOL)) {
    return deny(`The ${toolName} tool is not available in this workspace.`);
  }
  if (!ctx.tools.includes(tool)) {
    return deny(`The ${toolName} tool is not enabled for this agent.`);
  }
  if (tool === ASK_TOOL) {
    return { allow: true };
  }
  if (isProfileTool(tool)) {
    return decideProfileTool(tool, input, ctx);
  }
  const callDir = harnessCwd ?? ctx.cwd;
  const writesHarnessDir =
    tool === 'Bash'
      ? typeof input.command === 'string' && shellWritesHarnessDir(input.command, callDir)
      : (tool === 'Write' || tool === 'Edit') &&
        typeof input.file_path === 'string' &&
        underHarnessDir(input.file_path, callDir);
  if (writesHarnessDir) {
    return deny(
      `Path rejected: ${HARNESS_DIR} holds the harness and the approved profile, which this run may not change.`,
      SECURITY_TRACE_ERRORS.FILE_BLOCK
    );
  }
  const canonical = toCanonical(tool, input);
  if (!canonical) {
    return { allow: true };
  }
  return decideCanonicalCall(
    toolName,
    canonical,
    {
      containerId: ctx.containerId,
      cwd: ctx.cwd,
      extraReadRoots: [`${ctx.home}/.claude`, ...(ctx.profileDir ? [ctx.profileDir] : [])],
      protectedConfig: ctx.projectConfigLoaded
        ? { label: 'Claude Code', matches: isHarnessConfig }
        : undefined,
    },
    harnessCwd
  );
}
