import { makePatternLoader } from './scannerPatternLoader.js';
import { checkSensitiveFilePath } from './sensitiveFileScanner.js';

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

/**
 * Checks a shell command against active SHELL_COMMAND scanner patterns, then
 * against the SENSITIVE_FILE policy for anything the command writes to.
 *
 * Returns a human-readable block message (for the agent to self-correct) if the
 * command matches, or null if it is clean.
 */
export async function scanShellCommand(command: string): Promise<string | null> {
  const patterns = await loadShellPatterns();
  const truncate = () => (command.length > 200 ? `${command.slice(0, 200)}…` : command);

  for (const { label, re } of patterns) {
    re.lastIndex = 0;
    if (re.test(command)) {
      return (
        `Command blocked by security policy [${label}]:\n  ${truncate()}\n` +
        'Modify the command to avoid the restricted pattern and retry.'
      );
    }
  }

  for (const target of extractShellWriteTargets(command)) {
    const blocked = await checkSensitiveFilePath(target);
    if (blocked) {
      return (
        `Command blocked: it writes to '${target}', which matches the sensitive-file policy.\n` +
        `  ${truncate()}\n` +
        'Store secrets in environment variables or a secrets manager, not in source files.'
      );
    }
  }

  return null;
}
