import path from 'node:path';
import { SECURITY_TRACE_ERRORS } from '@auto-swe/shared/lib/scannerCache';
import { auditLog } from '../../lib/activityLog.js';
import { redactString } from '../../lib/agentTracer.js';
import { checkSensitiveFilePath } from '../../lib/sensitiveFileScanner.js';
import { scanShellCommand } from '../../lib/shellCommandScanner.js';
import { checkContentSecurity, formatViolationMessage } from '../preWriteSecurityCheck.js';

/**
 * The harness tools a workspace run may use — the same capability as the four
 * Mastra workspace tools (read, write, list, shell), under Claude Code's names.
 * Everything else the harness knows (web fetch, sub-agents, plugins' tools) is
 * denied until a profile grants it deliberately.
 */
export const HARNESS_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'] as const;

export type HarnessTool = (typeof HARNESS_TOOLS)[number];

/** Which harness tools stand in for each Mastra workspace tool key (`IMPLEMENTER_TOOL_IDS`). */
const HARNESS_TOOLS_BY_KEY: Record<string, readonly HarnessTool[]> = {
  bash: ['Bash'],
  listDirectory: ['Read', 'Glob', 'Grep'],
  readFile: ['Read', 'Glob', 'Grep'],
  writeFile: ['Write', 'Edit'],
};

/**
 * The harness tools a resolved Agent's `toolKeys` grant, read exactly as the
 * Mastra implementer reads them (`createImplementerAgent`): `null`, `[]`, or a
 * list naming no workspace tool (`['mcp']`) means all four, and otherwise only
 * the named tools are granted.
 */
export function harnessToolsFor(toolKeys: readonly string[] | null | undefined): HarnessTool[] {
  const granted = harnessToolsGranting(toolKeys ?? []);
  return granted.length === 0 ? [...HARNESS_TOOLS] : granted;
}

/**
 * The harness tools that stand in for exactly these workspace tool keys, with
 * no default: an empty grant is no tools. For a caller that has already decided
 * which workspace tools an agent gets (an agent run, `grantedWorkspaceToolIds`).
 */
export function harnessToolsGranting(keys: readonly string[]): HarnessTool[] {
  const granted = new Set(keys.flatMap((key) => HARNESS_TOOLS_BY_KEY[key] ?? []));
  return HARNESS_TOOLS.filter((t) => granted.has(t));
}

export type ToolDecision =
  | {
      allow: true;
      /** Appended to the tool result so the model sees it, as the Mastra write tool does. */
      warning?: string;
      /** The `AgentTrace.error` tag for a warning the security-events view reads. */
      securityTag?: string;
    }
  | { allow: false; reason: string; securityTag?: string };

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

/** `p` relative to `root` when it stays inside it (`''` for the root itself), else null. */
function within(root: string, p: string): string | null {
  if (p.includes('\0')) {
    return null;
  }
  const rel = path.posix.relative(root, path.posix.resolve(root, p));
  return rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel) ? null : rel;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

const deny = (reason: string, securityTag?: string): ToolDecision => ({
  allow: false,
  reason,
  securityTag,
});

/**
 * A tool's file path must be absolute. The harness resolves a relative one
 * against its own current directory, which a `cd` in an earlier Bash call moves
 * (`cd .git`, then `Write hooks/pre-push`); refusing it leaves every path the
 * policy checks with exactly one meaning. The harness's tools document absolute
 * paths, so a well-behaved call never sends anything else.
 */
function absolute(raw: unknown): string | undefined {
  const p = str(raw);
  return p !== undefined && path.posix.isAbsolute(p) ? p : undefined;
}

/** A write target: an absolute path inside the checkout, not the checkout itself. */
function writeTarget(raw: unknown, ctx: PolicyContext): { rel: string } | { error: string } {
  const p = absolute(raw);
  const rel = p === undefined ? null : within(ctx.cwd, p);
  return rel ? { rel } : { error: `Path rejected: writes take an absolute path inside ${ctx.cwd}` };
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
 * A read or search target: an absolute path in the checkout or the harness's
 * own `.claude` directory. With no path (Glob and Grep default to it) the target
 * is the harness's current directory, which must itself be in the checkout.
 */
function readAllowed(raw: unknown, ctx: PolicyContext, harnessCwd: string | undefined): boolean {
  if (raw === undefined || raw === null || raw === '') {
    const cwd = absolute(harnessCwd);
    return cwd !== undefined && within(ctx.cwd, cwd) !== null;
  }
  const p = absolute(raw);
  return (
    p !== undefined && (within(ctx.cwd, p) !== null || within(`${ctx.home}/.claude`, p) !== null)
  );
}

/**
 * The worker's verdict on one harness tool call, made before the harness runs it.
 *
 * This is the harness-side twin of the tool bodies in `workspaceTools.ts`: the
 * sensitive-file hard block, the pre-write content check and the shell-command
 * scanner, in the same order and with the same tags on the trace. It runs in the
 * worker, not in the container, so what the agent does inside the container
 * cannot edit it.
 *
 * Differences from the Mastra tools, forced by the harness's own tools:
 *  - the harness addresses files by absolute path, so every path must be
 *    absolute and is confined to the checkout here (the Mastra tools refused
 *    absolute paths outright); a search with no path is confined by the
 *    harness's current directory, `harnessCwd`, as its hook input reports it;
 *  - writes to the harness's own configuration in the checkout are refused
 *    while the harness loads it ({@link isHarnessConfig});
 *  - a harness tool the Agent's `toolKeys` do not grant is refused here as well
 *    as left out of the harness's tool list;
 *  - `Edit` carries a fragment, so the content check sees `new_string`, not the
 *    whole resulting file.
 *
 * A scanner that cannot complete throws, and the caller turns a throw into a
 * deny: the blocking scanners fail closed.
 */
export async function decideToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: PolicyContext,
  harnessCwd?: string
): Promise<ToolDecision> {
  if (
    (HARNESS_TOOLS as readonly string[]).includes(toolName) &&
    !ctx.tools.includes(toolName as HarnessTool)
  ) {
    return deny(`The ${toolName} tool is not enabled for this agent.`);
  }
  switch (toolName) {
    case 'Bash': {
      const command = str(input.command);
      if (command === undefined) {
        return deny('Bash needs a command.');
      }
      auditLog(
        `[bash:audit] container=${ctx.containerId} cmd=${JSON.stringify(redactString(command))}`
      );
      const blocked = await scanShellCommand(command);
      return blocked ? deny(blocked, SECURITY_TRACE_ERRORS.SHELL_BLOCK) : { allow: true };
    }

    case 'Write':
    case 'Edit': {
      const target = writeTarget(input.file_path, ctx);
      if ('error' in target) {
        return deny(target.error);
      }
      if (ctx.projectConfigLoaded && isHarnessConfig(target.rel)) {
        return deny(
          `Path rejected: ${target.rel} is Claude Code configuration, which this run loads and may not change.`
        );
      }
      const sensitive = await checkSensitiveFilePath(target.rel);
      if (sensitive) {
        return deny(sensitive, SECURITY_TRACE_ERRORS.FILE_BLOCK);
      }
      const content = toolName === 'Write' ? input.content : input.new_string;
      const check = checkContentSecurity(target.rel, typeof content === 'string' ? content : '');
      if (!check.passed) {
        return deny(
          formatViolationMessage(check.violations, true),
          SECURITY_TRACE_ERRORS.CONTENT_BLOCK
        );
      }
      return check.violations.length > 0
        ? {
            allow: true,
            securityTag: SECURITY_TRACE_ERRORS.CONTENT_WARN,
            warning: formatViolationMessage(check.violations, false),
          }
        : { allow: true };
    }

    case 'Read':
      return str(input.file_path) !== undefined && readAllowed(input.file_path, ctx, harnessCwd)
        ? { allow: true }
        : deny(`Path rejected: reads take an absolute path inside ${ctx.cwd}`);

    case 'Glob':
    case 'Grep': {
      // A glob is relative to `path`; an absolute or `..` pattern would walk out of it.
      const pattern = str(toolName === 'Glob' ? input.pattern : input.glob);
      if (pattern !== undefined && (path.posix.isAbsolute(pattern) || pattern.includes('..'))) {
        return deny('Pattern rejected: patterns must be relative and stay inside the checkout.');
      }
      return readAllowed(input.path, ctx, harnessCwd)
        ? { allow: true }
        : deny(
            `Path rejected: searches take an absolute path inside ${ctx.cwd}, or run from a directory inside it`
          );
    }

    default:
      return deny(`The ${toolName} tool is not available in this workspace.`);
  }
}
