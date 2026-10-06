import path from 'node:path';
import { SECURITY_TRACE_ERRORS } from '@auto-swe/shared/lib/scannerCache';
import { auditLog } from '../../lib/activityLog.js';
import { redactString } from '../../lib/agentTracer.js';
import { checkSensitiveFilePath } from '../../lib/sensitiveFileScanner.js';
import { scanShellCommand } from '../../lib/shellCommandScanner.js';
import { checkContentSecurity, formatViolationMessage } from '../preWriteSecurityCheck.js';

/**
 * The canonical tool vocabulary every harness's tools are mapped onto: the same
 * four capabilities as the Mastra workspace tools, and the scanners that guard
 * them. An adapter names which of its native tools exercise which capability;
 * the policy below decides the call in those terms, so a new harness inherits
 * the scanners instead of re-implementing them.
 *
 *  - `read`   — read one file                       → path confinement
 *  - `search` — list or search a tree               → path and pattern confinement
 *  - `write`  — create or change a file             → sensitive-file block, pre-write content check
 *  - `shell`  — run a command                       → audit line, shell-command scanner
 */
export const CANONICAL_TOOLS = ['read', 'search', 'write', 'shell'] as const;

export type CanonicalTool = (typeof CANONICAL_TOOLS)[number];

/** Which canonical capabilities each Mastra workspace tool key (`IMPLEMENTER_TOOL_IDS`) grants. */
const CANONICAL_BY_KEY: Record<string, readonly CanonicalTool[]> = {
  bash: ['shell'],
  listDirectory: ['read', 'search'],
  readFile: ['read', 'search'],
  writeFile: ['write'],
};

/**
 * The canonical capabilities a resolved Agent's `toolKeys` grant, read exactly
 * as the Mastra implementer reads them (`createImplementerAgent`): `null`, `[]`,
 * or a list naming no workspace tool (`['mcp']`) means all four, and otherwise
 * only the named tools are granted.
 */
export function canonicalToolsFor(
  toolKeys: readonly string[] | null | undefined
): Set<CanonicalTool> {
  const granted = new Set((toolKeys ?? []).flatMap((key) => CANONICAL_BY_KEY[key] ?? []));
  return granted.size === 0 ? new Set(CANONICAL_TOOLS) : granted;
}

/**
 * The canonical capabilities exactly these workspace tool keys grant, with no
 * default: an empty grant is no capability. For a caller that has already
 * decided which workspace tools an agent gets (an agent run,
 * `grantedWorkspaceToolIds`), where "no opinion means everything" must not apply.
 */
export function canonicalToolsGranting(keys: readonly string[]): Set<CanonicalTool> {
  return new Set(keys.flatMap((key) => CANONICAL_BY_KEY[key] ?? []));
}

/** A harness's native tools and the canonical capability each one exercises. */
export interface ToolVocabulary<T extends string> {
  /** Every native tool a workspace run may use, in the order the harness is offered them. */
  tools: readonly T[];
  canonical: Readonly<Record<T, CanonicalTool>>;
}

/** The native tools that exercise the `granted` capabilities, in the vocabulary's order. */
export function nativeTools<T extends string>(
  vocabulary: ToolVocabulary<T>,
  granted: ReadonlySet<CanonicalTool>
): T[] {
  return vocabulary.tools.filter((tool) => granted.has(vocabulary.canonical[tool]));
}

/** The native tools `toolKeys` grant, read as the Mastra implementer reads them. */
export function nativeToolsFor<T extends string>(
  vocabulary: ToolVocabulary<T>,
  toolKeys: readonly string[] | null | undefined
): T[] {
  return nativeTools(vocabulary, canonicalToolsFor(toolKeys));
}

/**
 * One native tool call, translated into the canonical vocabulary. Paths and
 * patterns are passed through as the harness sent them (`unknown`): validating
 * them is the policy's job, not the adapter's.
 */
export type CanonicalToolCall =
  | { tool: 'read'; path: unknown }
  | { tool: 'search'; path: unknown; pattern: unknown }
  | {
      tool: 'write';
      path: unknown;
      /** The text the call inserts: the whole file, or the fragment an edit adds. */
      content: unknown;
    }
  | { tool: 'shell'; command: unknown };

export type ToolDecision =
  | {
      allow: true;
      /** Appended to the tool result so the model sees it, as the Mastra write tool does. */
      warning?: string;
      /** The `AgentTrace.error` tag for a warning the security-events view reads. */
      securityTag?: string;
    }
  | { allow: false; reason: string; securityTag?: string };

export interface CanonicalPolicyContext {
  containerId: string;
  /** The repository checkout — the only place the harness may write. */
  cwd: string;
  /** Directories outside the checkout a `read` or `search` may reach (the harness's own state). */
  extraReadRoots: readonly string[];
  /**
   * The harness's own configuration inside the checkout, which it reads when a
   * turn starts: a write there would change what the next turn runs under.
   * Omitted when the run does not load it.
   */
  protectedConfig?: {
    /** Names the harness in the refusal (`Claude Code`). */
    label: string;
    matches(relativePath: string): boolean;
  };
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

export const deny = (reason: string, securityTag?: string): ToolDecision => ({
  allow: false,
  reason,
  securityTag,
});

/**
 * A tool's file path must be absolute. A harness resolves a relative one
 * against its own current directory, which a `cd` in an earlier shell call
 * moves (`cd .git`, then a write of `hooks/pre-push`); refusing it leaves every
 * path the policy checks with exactly one meaning.
 */
function absolute(raw: unknown): string | undefined {
  const p = str(raw);
  return p !== undefined && path.posix.isAbsolute(p) ? p : undefined;
}

/** A write target: an absolute path inside the checkout, not the checkout itself. */
function writeTarget(
  raw: unknown,
  ctx: CanonicalPolicyContext
): { rel: string } | { error: string } {
  const p = absolute(raw);
  const rel = p === undefined ? null : within(ctx.cwd, p);
  return rel ? { rel } : { error: `Path rejected: writes take an absolute path inside ${ctx.cwd}` };
}

/**
 * A read or search target: an absolute path in the checkout or one of the
 * harness's own read roots. With no path (a search defaults to it) the target
 * is the harness's current directory, which must itself be in the checkout.
 */
function readAllowed(
  raw: unknown,
  ctx: CanonicalPolicyContext,
  harnessCwd: string | undefined
): boolean {
  if (raw === undefined || raw === null || raw === '') {
    const cwd = absolute(harnessCwd);
    return cwd !== undefined && within(ctx.cwd, cwd) !== null;
  }
  const p = absolute(raw);
  return (
    p !== undefined &&
    (within(ctx.cwd, p) !== null || ctx.extraReadRoots.some((root) => within(root, p) !== null))
  );
}

/**
 * The worker's verdict on one tool call, in canonical terms, made before the
 * harness runs it.
 *
 * This is the harness-side twin of the tool bodies in `workspaceTools.ts`: the
 * sensitive-file hard block, the pre-write content check and the shell-command
 * scanner, in the same order and with the same tags on the trace. It runs in the
 * worker, not in the container, so what the agent does inside the container
 * cannot edit it.
 *
 * Differences from the Mastra tools, forced by the harnesses' own tools:
 *  - a harness addresses files by absolute path, so every path must be absolute
 *    and is confined to the checkout here (the Mastra tools refused absolute
 *    paths outright); a search with no path is confined by the harness's current
 *    directory, `harnessCwd`, as the harness reports it;
 *  - writes to the harness's own configuration in the checkout are refused
 *    while the harness loads it (`ctx.protectedConfig`);
 *  - an edit carries a fragment, so the content check sees the inserted text,
 *    not the whole resulting file.
 *
 * `toolName` is the native name, used only to word the refusal. A scanner that
 * cannot complete throws, and the caller turns a throw into a deny: the
 * blocking scanners fail closed.
 */
export async function decideCanonicalCall(
  toolName: string,
  call: CanonicalToolCall,
  ctx: CanonicalPolicyContext,
  harnessCwd?: string
): Promise<ToolDecision> {
  switch (call.tool) {
    case 'shell': {
      const command = str(call.command);
      if (command === undefined) {
        return deny(`${toolName} needs a command.`);
      }
      auditLog(
        `[bash:audit] container=${ctx.containerId} cmd=${JSON.stringify(redactString(command))}`
      );
      const blocked = await scanShellCommand(command);
      return blocked ? deny(blocked, SECURITY_TRACE_ERRORS.SHELL_BLOCK) : { allow: true };
    }

    case 'write': {
      const target = writeTarget(call.path, ctx);
      if ('error' in target) {
        return deny(target.error);
      }
      if (ctx.protectedConfig?.matches(target.rel)) {
        return deny(
          `Path rejected: ${target.rel} is ${ctx.protectedConfig.label} configuration, which this run loads and may not change.`
        );
      }
      const sensitive = await checkSensitiveFilePath(target.rel);
      if (sensitive) {
        return deny(sensitive, SECURITY_TRACE_ERRORS.FILE_BLOCK);
      }
      const check = checkContentSecurity(
        target.rel,
        typeof call.content === 'string' ? call.content : ''
      );
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

    case 'read':
      return str(call.path) !== undefined && readAllowed(call.path, ctx, harnessCwd)
        ? { allow: true }
        : deny(`Path rejected: reads take an absolute path inside ${ctx.cwd}`);

    case 'search': {
      // A pattern is relative to the search root; an absolute or `..` pattern would walk out of it.
      const pattern = str(call.pattern);
      if (pattern !== undefined && (path.posix.isAbsolute(pattern) || pattern.includes('..'))) {
        return deny('Pattern rejected: patterns must be relative and stay inside the checkout.');
      }
      return readAllowed(call.path, ctx, harnessCwd)
        ? { allow: true }
        : deny(
            `Path rejected: searches take an absolute path inside ${ctx.cwd}, or run from a directory inside it`
          );
    }
  }
}

/**
 * How long the worker's policy may take over one tool call before the call is
 * refused. The scanners are bounded well inside this; it is here so a stalled
 * dependency (the pattern store) ends in a deny the worker chose. An adapter
 * whose harness has its own deadline for the answer sets it longer than this,
 * so the worker always answers first.
 */
export const POLICY_DECISION_MS = 60_000;

/**
 * `decide()`, bounded: a deny once `ms` have passed without a verdict, and a
 * deny when the decision throws — a scanner that cannot complete cannot clear
 * the call.
 */
export async function decideWithinDeadline(
  decide: () => Promise<ToolDecision>,
  ms: number = POLICY_DECISION_MS
): Promise<ToolDecision> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<ToolDecision>((resolve) => {
    timer = setTimeout(
      () =>
        resolve(
          deny(`The security check did not finish within ${ms / 1000} s; the call was refused.`)
        ),
      ms
    );
  });
  try {
    return await Promise.race([decide(), expired]);
  } catch (err) {
    return deny(
      `The security check could not complete (${err instanceof Error ? err.message : String(err)}); the call was refused.`
    );
  } finally {
    clearTimeout(timer);
  }
}
