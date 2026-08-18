import { runRegexBatch, toRegexSpecs } from '@auto-swe/shared/lib/regexExec';
import { chunkScanText } from '@auto-swe/shared/lib/regexSafety';
import {
  checkContentSecurity,
  SECURITY_CHECK_FAILED_PREFIX,
} from '../agents/preWriteSecurityCheck.js';
import { makePatternLoader } from './scannerPatternLoader.js';
import { checkSensitiveFilePaths } from './sensitiveFileScanner.js';

const { load: loadShellPatterns, invalidate } = makePatternLoader(
  'SHELL_COMMAND',
  'shellCommandScanner'
);

export { invalidate as invalidateShellCommandPatternCache };

/**
 * Ways a shell command writes to a path. The `writeFile` tool is gated by
 * {@link checkSensitiveFilePath}, but `bash` reaches the same filesystem, so
 * without this the sensitive-file policy stops at the tool boundary and
 * `echo secret > .env` walks straight past it.
 *
 * Each regex captures the destination path in its last group.
 */
const WRITE_TARGET_PATTERNS: RegExp[] = [
  // Redirection: `> f`, `>> f`, `2> f`, `&> f`. Not `>&2` (fd duplication).
  /(?:^|[\s;&|(])(?:\d+|&)?>{1,2}\s*(?!&)(?:'([^']+)'|"([^"]+)"|([^\s;&|)<>'"]+))/g,
  // tee, optionally appending, possibly several destinations.
  /\btee\b(?:\s+(?:-a|--append|-i|--ignore-interrupts))*\s+(?:'([^']+)'|"([^"]+)"|([^\s;&|)<>'"-][^\s;&|)<>'"]*))/g,
  // dd of=path
  /\bdd\b[^;&|]*?\bof=(?:'([^']+)'|"([^"]+)"|([^\s;&|)<>'"]+))/g,
];

/**
 * `cp`/`mv`/`install` write to their *last* operand, which the patterns above
 * cannot express — the operand count is variable. Handled separately.
 */
const COPY_MOVE_RE =
  /\b(?:cp|mv|install)\b((?:\s+(?:-[^\s;&|]+|'[^']+'|"[^"]+"|[^\s;&|)<>'"]+))+)/g;

/** Writes here are routine and carry no secrets. */
function isUninterestingTarget(path: string): boolean {
  return path.startsWith('/dev/') || path === '-' || path.startsWith('$');
}

function pushMatch(out: Set<string>, groups: (string | undefined)[]): void {
  const value = groups.find((g) => g !== undefined);
  if (value && !isUninterestingTarget(value)) {
    out.add(value);
  }
}

/**
 * Best-effort extraction of paths a shell command writes to.
 *
 * Deliberately over-collects rather than under-collects: a false positive costs
 * one soft block the agent can work around, while a miss reopens the bypass this
 * exists to close. It is a heuristic over command *text*, not a shell parser —
 * an agent determined to evade it can (`printf` into a variable, `eval`, base64
 * a filename). It raises the floor; it is not a containment boundary.
 */
export function extractShellWriteTargets(command: string): string[] {
  const targets = new Set<string>();

  for (const re of WRITE_TARGET_PATTERNS) {
    re.lastIndex = 0;
    for (const m of command.matchAll(re)) {
      pushMatch(targets, [m[1], m[2], m[3]]);
    }
  }

  COPY_MOVE_RE.lastIndex = 0;
  for (const m of command.matchAll(COPY_MOVE_RE)) {
    const operands = (m[1] ?? '')
      .trim()
      .split(/\s+/)
      .filter((o) => o && !o.startsWith('-'));
    const destination = operands.at(-1);
    // A lone operand is a source with no destination — nothing written.
    if (destination && operands.length > 1) {
      pushMatch(targets, [destination.replace(/^['"]|['"]$/g, '')]);
    }
  }

  return [...targets];
}

/** A literal write whose content is visible in the command text. */
export interface ShellWrite {
  target: string;
  content: string;
}

/**
 * `echo`/`printf` into a redirect, and here-docs. These are the shapes where
 * the *content* being written is present in the command text, so the pre-write
 * content rules can inspect it — the OWASP-style checks otherwise stop at the
 * `writeFile` tool boundary and a secret hardcoded through `bash` sails past.
 */
const ECHO_REDIRECT_RE =
  /\b(?:echo|printf)\b\s+(?:-[a-zA-Z]+\s+)*(?:'([^']*)'|"([^"]*)"|([^\s;&|<>]+))[^;&|<>]*?>{1,2}\s*(?:'([^']+)'|"([^"]+)"|([^\s;&|)<>'"]+))/g;

/** `cmd > file <<'EOF' … EOF` and `cmd <<EOF … EOF > file`. */
const HEREDOC_RE =
  /<<-?\s*(?:'([A-Za-z_][\w]*)'|"([A-Za-z_][\w]*)"|([A-Za-z_][\w]*))([\s\S]*?)^\3?\2?\1?$/gm;

/**
 * Best-effort extraction of literal content a command writes, paired with its
 * destination. Only handles content that is *inline* in the command — a write
 * fed from a pipe, a variable, or another process is invisible here by
 * construction. Same posture as {@link extractShellWriteTargets}: it raises the
 * floor, it is not a containment boundary.
 */
export function extractShellWrites(command: string): ShellWrite[] {
  const writes: ShellWrite[] = [];

  ECHO_REDIRECT_RE.lastIndex = 0;
  for (const m of command.matchAll(ECHO_REDIRECT_RE)) {
    const content = m[1] ?? m[2] ?? m[3];
    const target = m[4] ?? m[5] ?? m[6];
    if (content !== undefined && target && !isUninterestingTarget(target)) {
      writes.push({ content, target });
    }
  }

  // A here-doc's body is the content; its target is whatever the same command
  // redirects to, so reuse the redirect extraction for the destination.
  HEREDOC_RE.lastIndex = 0;
  for (const m of command.matchAll(HEREDOC_RE)) {
    const body = m[4];
    if (!body) {
      continue;
    }
    for (const target of extractShellWriteTargets(command)) {
      writes.push({ content: body, target });
    }
  }

  return writes;
}

/**
 * Checks a shell command against active SHELL_COMMAND scanner patterns, then
 * against the SENSITIVE_FILE policy for anything the command writes to.
 *
 * Returns a human-readable block message (for the agent to self-correct) if the
 * command matches, or null if it is clean.
 *
 * This is a BLOCKING scanner, which drives two choices:
 *
 * - The whole command is scanned, in overlapping windows. Truncating it would
 *   be a bypass: 20k of leading `#` comment would push a forbidden command past
 *   a plain cap and out of the rule's sight.
 * - A scan that cannot complete blocks. If a pattern burns its execution budget
 *   the scanner cannot say the command is clean, so it does not.
 */
export async function scanShellCommand(command: string): Promise<string | null> {
  const patterns = await loadShellPatterns();
  const truncate = () => (command.length > 200 ? `${command.slice(0, 200)}…` : command);

  const { hits, incomplete } = await runRegexBatch(
    toRegexSpecs(patterns),
    chunkScanText(command).map((text, i) => ({ key: String(i), text })),
    { label: 'shellCommandScanner' }
  );
  const hit = hits[0];
  if (hit) {
    return (
      `Command blocked by security policy [${hit.patternKey}]:\n  ${truncate()}\n` +
      'Modify the command to avoid the restricted pattern and retry.'
    );
  }
  if (incomplete) {
    return (
      `Command blocked: the shell security scan could not complete.\n  ${truncate()}\n` +
      'A scanner pattern exceeded its execution budget, so the command could not be ' +
      'cleared. Retry; if this persists, an administrator must fix the offending ' +
      'pattern at /admin/scanner.'
    );
  }

  const writeTargets = extractShellWriteTargets(command);
  if (writeTargets.length > 0) {
    // One combined round trip for every write target this command has, rather
    // than one `checkSensitiveFilePath` call — and one serialized trip through
    // the regex executor — per target.
    const blockedTarget = await checkSensitiveFilePaths(writeTargets);
    if (blockedTarget) {
      return (
        `Command blocked: it writes to '${blockedTarget}', which matches the sensitive-file policy.\n` +
        `  ${truncate()}\n` +
        'Store secrets in environment variables or a secrets manager, not in source files.'
      );
    }
  }

  // Same CRITICAL-only bar as the writeFile tool: `passed` is false only when a
  // CRITICAL rule fired, so warnings do not block a legitimate command.
  for (const { content, target } of extractShellWrites(command)) {
    const { passed, violations } = checkContentSecurity(target, content);
    if (!passed) {
      const critical = violations.filter((v) => v.severity === 'CRITICAL');
      const detail = critical.map((v) => `  - [${v.ruleId}] ${v.description}`).join('\n');
      return (
        `${SECURITY_CHECK_FAILED_PREFIX}: the content written to '${target}' violates a critical rule.\n${detail}\n` +
        `  ${truncate()}\n` +
        `${critical[0]?.suggestedFix ?? 'Remove the flagged content and retry.'}`
      );
    }
  }

  return null;
}
