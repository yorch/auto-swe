import path from 'node:path';
import { SECURITY_TRACE_ERRORS } from '@auto-swe/shared/lib/scannerCache';
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

/** A write target: inside the checkout, not the checkout itself. */
function writeTarget(raw: unknown, ctx: PolicyContext): { rel: string } | { error: string } {
  const p = str(raw);
  const rel = p === undefined ? null : within(ctx.cwd, p);
  return rel ? { rel } : { error: `Path rejected: writes must stay inside ${ctx.cwd}` };
}

/** A read target: the checkout, or the harness's own `.claude` directory. */
function readAllowed(raw: unknown, ctx: PolicyContext): boolean {
  const p = str(raw) ?? ctx.cwd;
  return within(ctx.cwd, p) !== null || within(`${ctx.home}/.claude`, p) !== null;
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
 *  - the harness addresses files by absolute path, so every path is confined to
 *    the checkout here (the Mastra tools refused absolute paths outright);
 *  - `Edit` carries a fragment, so the content check sees `new_string`, not the
 *    whole resulting file.
 *
 * A scanner that cannot complete throws, and the caller turns a throw into a
 * deny: the blocking scanners fail closed.
 */
export async function decideToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: PolicyContext
): Promise<ToolDecision> {
  switch (toolName) {
    case 'Bash': {
      const command = str(input.command);
      if (command === undefined) {
        return deny('Bash needs a command.');
      }
      console.log(
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
      return readAllowed(input.file_path, ctx)
        ? { allow: true }
        : deny(`Path rejected: reads must stay inside ${ctx.cwd}`);

    case 'Glob':
    case 'Grep': {
      // A glob is relative to `path`; an absolute or `..` pattern would walk out of it.
      const pattern = str(toolName === 'Glob' ? input.pattern : input.glob);
      if (pattern !== undefined && (path.posix.isAbsolute(pattern) || pattern.includes('..'))) {
        return deny('Pattern rejected: patterns must be relative and stay inside the checkout.');
      }
      return readAllowed(input.path, ctx)
        ? { allow: true }
        : deny(`Path rejected: searches must stay inside ${ctx.cwd}`);
    }

    default:
      return deny(`The ${toolName} tool is not available in this workspace.`);
  }
}
