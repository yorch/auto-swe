import path from 'node:path';
import type { HarnessCapabilities } from '../harness/adapter.js';
import { WORKSPACE_DIR } from '../harness/adapter.js';
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
import { TOOL_OUTPUT_OFFLOAD_DIR } from '../toolOutputOffload.js';

/**
 * Pi's tools a workspace run may use: its four defaults (`read`, `bash`,
 * `edit`, `write`) and `ls`. Pi's `grep` and `find` are not offered: `grep`
 * always runs ripgrep on the machine the loop runs on, which here is the
 * worker, and `bash` reaches both in the container.
 */
export const PI_TOOLS = ['read', 'bash', 'edit', 'write', 'ls'] as const;

export type PiTool = (typeof PI_TOOLS)[number];

/**
 * Pi's agent loop runs in the worker and awaits its `beforeToolCall` hook, a
 * callback in this process, before every tool call; a hook that throws or
 * blocks keeps the call from running. Nothing of the loop is in the container,
 * and nothing from the repository is loaded into it.
 */
export const PI_CAPABILITIES: HarnessCapabilities = {
  enforcesPerCallPolicyInWorker: true,
};

/** Pi's tools in the canonical vocabulary (`harness/policy.ts`). */
export const PI_TOOL_VOCABULARY: ToolVocabulary<PiTool> = {
  canonical: {
    bash: 'shell',
    edit: 'write',
    ls: 'search',
    read: 'read',
    write: 'write',
  },
  tools: PI_TOOLS,
};

/**
 * Pi's tools a resolved Agent's `toolKeys` grant, read exactly as the Mastra
 * implementer reads them: `readFile` and `listDirectory` grant `read` and `ls`;
 * `writeFile` grants `write` and `edit`; `bash` grants `bash`; `null`, `[]`, or
 * a list naming no workspace tool grants all five.
 */
export function piToolsFor(toolKeys: readonly string[] | null | undefined): PiTool[] {
  return nativeToolsFor(PI_TOOL_VOCABULARY, toolKeys);
}

/** Pi's tools that stand in for exactly these workspace tool keys; an empty grant is no tools. */
export function piToolsGranting(keys: readonly string[]): PiTool[] {
  return nativeTools(PI_TOOL_VOCABULARY, canonicalToolsGranting(keys));
}

/** The tools whose `path` argument names a file or directory. */
const PATH_TOOLS: ReadonlySet<string> = new Set<PiTool>(['read', 'edit', 'write', 'ls']);

/**
 * Characters Pi's path handling rewrites before it uses a path (it folds
 * Unicode spaces to an ASCII space). A path holding one would be decided as one
 * name and opened as another, so it is refused.
 */
const REWRITTEN_SPACES = /[  -   　]/;

/**
 * The absolute path a Pi tool's `path` argument names, or a reason it is
 * refused. Pi resolves a path itself (`@` and `~` prefixes, Unicode spaces,
 * relative to its working directory); resolving it here first, to a form Pi
 * leaves unchanged, is what makes the path the policy decides the path the tool
 * opens. A relative path is relative to the checkout: the loop runs in the
 * worker and no tool call moves its working directory.
 */
export function resolvePiPath(raw: unknown): { path: string } | { error: string } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { error: 'a path is required' };
  }
  if (raw.startsWith('@') || raw.startsWith('~')) {
    return { error: `write the path without its leading '${raw[0]}'` };
  }
  if (REWRITTEN_SPACES.test(raw)) {
    return { error: 'the path holds a Unicode space; name the file with plain characters' };
  }
  return { path: path.posix.resolve(WORKSPACE_DIR, raw) };
}

/**
 * Rewrite a Pi tool call's `path` argument, in place, to the absolute path
 * {@link resolvePiPath} gives, before the call is decided. `ls` with no path
 * lists the checkout. The tool runs on the same object, so it opens the path
 * that was decided. Returns why the path is refused, or null.
 */
export function canonicalisePiArgs(toolName: string, args: Record<string, unknown>): string | null {
  if (!PATH_TOOLS.has(toolName)) {
    return null;
  }
  const raw = toolName === 'ls' && (args.path === undefined || args.path === '') ? '.' : args.path;
  const resolved = resolvePiPath(raw);
  if ('error' in resolved) {
    return `Path rejected: ${resolved.error}.`;
  }
  args.path = resolved.path;
  return null;
}

export interface PiPolicyContext {
  containerId: string;
  /** The Pi tools the Agent's `toolKeys` grant ({@link piToolsFor}). */
  tools: readonly PiTool[];
  /**
   * The run reads the repository's root `AGENTS.md` (else `CLAUDE.md`) into the
   * system prompt, so the agent may not rewrite either: a later session would
   * run under what it wrote.
   */
  projectContextLoaded: boolean;
}

/** The repository's own context files the run reads, at the checkout's root. */
export function isPiContextFile(rel: string): boolean {
  const lower = rel.toLowerCase();
  return lower === 'agents.md' || lower === 'claude.md';
}

/** One Pi tool call in the canonical vocabulary. */
function toCanonical(tool: PiTool, input: Record<string, unknown>): CanonicalToolCall {
  switch (tool) {
    case 'bash':
      return { command: input.command, tool: 'shell' };
    case 'write':
      return { content: input.content, path: input.path, tool: 'write' };
    // An edit carries fragments, so the content check sees every replacement text.
    case 'edit':
      return {
        content: Array.isArray(input.edits)
          ? input.edits.map((e) => (typeof e?.newText === 'string' ? e.newText : '')).join('\n')
          : '',
        path: input.path,
        tool: 'write',
      };
    case 'read':
      return { path: input.path, tool: 'read' };
    case 'ls':
      return { path: input.path, pattern: undefined, tool: 'search' };
  }
}

/**
 * The worker's verdict on one Pi tool call, made before Pi runs it: the call
 * is translated into the canonical vocabulary and decided by
 * `decideCanonicalCall`, which applies the scanners that guard the Mastra tools.
 *
 * Paths must already be absolute ({@link canonicalisePiArgs} makes them so); a
 * path Pi would rewrite before opening it is refused. Reads may also reach the
 * offloaded tool output beside the checkout, where the `bash` tool writes the
 * full text of an oversized result. A tool outside {@link PI_TOOLS}, or one the
 * Agent's `toolKeys` do not grant, is refused.
 */
export async function decidePiToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: PiPolicyContext
): Promise<ToolDecision> {
  if (!(PI_TOOLS as readonly string[]).includes(toolName)) {
    return deny(`The ${toolName} tool is not available in this workspace.`);
  }
  const tool = toolName as PiTool;
  if (!ctx.tools.includes(tool)) {
    return deny(`The ${toolName} tool is not enabled for this agent.`);
  }
  if (PATH_TOOLS.has(tool) && typeof input.path === 'string' && REWRITTEN_SPACES.test(input.path)) {
    return deny(
      'Path rejected: the path holds a Unicode space; name the file with plain characters.'
    );
  }
  return decideCanonicalCall(
    toolName,
    toCanonical(tool, input),
    {
      containerId: ctx.containerId,
      cwd: WORKSPACE_DIR,
      extraReadRoots: [TOOL_OUTPUT_OFFLOAD_DIR],
      protectedConfig: ctx.projectContextLoaded
        ? { label: 'Pi', matches: isPiContextFile }
        : undefined,
    },
    WORKSPACE_DIR
  );
}
