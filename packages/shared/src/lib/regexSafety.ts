/**
 * Write-time policy for operator- and bundle-supplied regular expressions, plus
 * the input-shaping helpers the scanners use at read time.
 *
 * Everything here is **pure and synchronous** on purpose: `@auto-swe/sdk` and
 * bundle validation depend on it and must stay I/O-free. The part that actually
 * contains a catastrophic pattern — running it under a wall-clock budget in a
 * killable thread — lives in `./regexExec.ts`, which owns `node:worker_threads`.
 *
 * What this module does NOT do any more: statically decide whether a pattern
 * "looks like" a ReDoS. That analysis shipped once and was removed. It missed
 * real hangs (`(a+){1,50}$`, `a+a+$`, `(w+)+$`) while rejecting ordinary linear
 * patterns — including two of this repo's own hardcoded scanner regexes in
 * `shellCommandScanner.ts`. Shape-matching a backtracking engine is not a
 * defensible gate; executing under a bound is.
 */

/** Mirrors the admin API's body cap; enforced here so bundle install shares it. */
export const MAX_PATTERN_SOURCE_LENGTH = 2000;

/**
 * Hard cap on the text an ADVISORY scanner runs a pattern over.
 *
 * Truncation is only acceptable where a missed match costs a warning. Blocking
 * scanners must NOT truncate — dropping the tail of an input is a detection
 * bypass (pad a forbidden command with 20k of comment and the block rule never
 * sees it). Those use {@link chunkScanText} instead, which covers the whole
 * input.
 */
export const MAX_SCAN_TEXT_LENGTH = 20_000;

/**
 * Overlap between the windows {@link chunkScanText} produces. A match longer
 * than this can straddle a window boundary and be missed, so it must exceed the
 * longest plausible match for the scanners that use it (shell commands and file
 * paths, where a single matched token is tens of characters, not thousands).
 */
export const SCAN_CHUNK_OVERLAP = 2_000;

/**
 * Mirrors the admin API's skill `promptText` cap (`POST /admin/skills`,
 * `PUT /admin/skills/:id`). Not regex-related, but co-located with the other
 * "admin API cap mirrored at bundle install" constants above so bundle install
 * cannot be a back door around a limit the admin API enforces.
 */
export const MAX_SKILL_PROMPT_TEXT_LENGTH = 50_000;

/**
 * Safe flag subset — `g`/`y` are stateful (`lastIndex`) on a cached RegExp.
 * Exported so the gateway's request schema and this check cannot drift apart.
 */
export const SAFE_FLAGS_RE = /^[imsuv]*$/;

export const SAFE_FLAGS_MESSAGE =
  "flags may only contain i, m, s, u, v — 'g' and 'y' are not allowed";

/**
 * `REDOS_RISK` is never produced by {@link checkRegexSafety} — it is the admin
 * API's code for a pattern the empirical `probeRegexBacktracking` watched blow
 * its execution budget. It stays in this union so both rejections travel to the
 * client in one shape.
 */
export type RegexSafetyCode = 'INVALID_REGEX' | 'UNSAFE_FLAGS' | 'PATTERN_TOO_LONG' | 'REDOS_RISK';

export interface RegexSafetyIssue {
  code: RegexSafetyCode;
  message: string;
}

/**
 * Validate a pattern body + flags for use as a scanner pattern. Returns `null`
 * when the pattern is acceptable, or a single actionable issue.
 *
 * This is a syntax-and-size policy, not a safety analysis: it rejects what will
 * not compile, what carries a stateful flag, and what is absurdly long. It makes
 * **no claim** about the pattern's execution cost — see `regexExec.ts` for the
 * bound that does, and `probeRegexBacktracking` for the empirical write-time
 * check the admin API layers on top of this.
 */
export function checkRegexSafety(pattern: string, flags = ''): RegexSafetyIssue | null {
  if (!SAFE_FLAGS_RE.test(flags)) {
    return { code: 'UNSAFE_FLAGS', message: SAFE_FLAGS_MESSAGE };
  }
  try {
    new RegExp(pattern, flags);
  } catch (err) {
    return {
      code: 'INVALID_REGEX',
      message: err instanceof Error ? err.message : 'Invalid regular expression',
    };
  }
  if (pattern.length > MAX_PATTERN_SOURCE_LENGTH) {
    return {
      code: 'PATTERN_TOO_LONG',
      message: `pattern is ${pattern.length} characters; the maximum is ${MAX_PATTERN_SOURCE_LENGTH}`,
    };
  }
  return null;
}

/**
 * Truncate text to the advisory scan cap (see {@link MAX_SCAN_TEXT_LENGTH}).
 *
 * ADVISORY CALLERS ONLY. Losing the tail of an LLM response costs a warning; in
 * a blocking scanner the same truncation is a bypass.
 */
export function capScanText(text: string): string {
  return text.length > MAX_SCAN_TEXT_LENGTH ? text.slice(0, MAX_SCAN_TEXT_LENGTH) : text;
}

/**
 * Split text into overlapping windows that together cover ALL of it, so a
 * blocking scanner can bound per-run work without creating a place to hide.
 *
 * Short text yields exactly one window (the text itself), so the common case is
 * allocation-free in practice.
 */
export function chunkScanText(
  text: string,
  windowSize = MAX_SCAN_TEXT_LENGTH,
  overlap = SCAN_CHUNK_OVERLAP
): string[] {
  if (text.length <= windowSize) {
    return [text];
  }
  const stride = Math.max(1, windowSize - overlap);
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += stride) {
    chunks.push(text.slice(start, start + windowSize));
    if (start + windowSize >= text.length) {
      break;
    }
  }
  return chunks;
}

/**
 * Canonical spelling of a shell command for scanning: line continuations
 * (`\` + newline, which the shell deletes) are removed, every run of
 * horizontal whitespace becomes one space, and every whitespace run that
 * contains a newline becomes one newline.
 *
 * None of that changes what the shell runs, and all of it is free padding: a
 * `curl` followed by 3,500 spaces (or 3,500 continuation lines) before its
 * `-T /etc/passwd` is one upload, but the match is longer than any fixed window
 * overlap. Scanning this form takes the padding away.
 */
export function canonicalizeShellForScan(command: string): string {
  return command
    .replace(/\\\r?\n/g, '')
    .replace(/[^\S\n]*\n\s*/g, '\n')
    .replace(/[^\S\n]+/g, ' ');
}

/** Shell list/pipe operators — where one simple command ends and the next begins. */
const SHELL_SEGMENT_SEPARATOR = /[;&|]/g;

/**
 * Windows for a BLOCKING shell scan that follow command structure instead of
 * fixed offsets.
 *
 * {@link chunkScanText} misses any match longer than its overlap that straddles
 * a window edge, and the built-in shell rules are deliberately unbounded within
 * a command (`\bcurl\b<rest of segment>\s-T\s`): their match runs from the
 * command word to the flag, however far apart. So here every window starts at a
 * segment boundary (on the `;`/`&`/`|` itself, so a rule that looks at the
 * preceding operator still sees it), holds WHOLE segments, and carries the whole
 * next segment — or `overlap` characters, whichever is longer — of what follows
 * (a `| sh` after a download, a `| … curl` after an encoder). A segment longer than
 * `windowSize` becomes a window on its own, uncut — a per-window budget still
 * bounds its cost, and a blocking scanner fails closed if it overruns.
 *
 * Guarantees, for every match: it is seen if it lies within two adjacent
 * segments, within one segment plus `overlap` characters beyond it, or if it is
 * no longer than `overlap`. Nothing
 * is truncated: every character lands in at least one window.
 */
export function shellScanWindows(
  command: string,
  windowSize = MAX_SCAN_TEXT_LENGTH,
  overlap = SCAN_CHUNK_OVERLAP
): string[] {
  if (command.length <= windowSize) {
    return [command];
  }
  // Segment starts: 0 and the index of every separator character.
  const starts: number[] = [0];
  SHELL_SEGMENT_SEPARATOR.lastIndex = 0;
  for (const m of command.matchAll(SHELL_SEGMENT_SEPARATOR)) {
    if (m.index > 0) {
      starts.push(m.index);
    }
  }
  starts.push(command.length);

  const windows: string[] = [];
  let i = 0;
  while (i < starts.length - 1) {
    const from = starts[i] as number;
    // Always take at least one segment, then as many whole ones as still fit.
    let j = i + 1;
    while (j < starts.length - 1 && (starts[j + 1] as number) - from <= windowSize) {
      j++;
    }
    const to = starts[j] as number;
    // Carry the whole NEXT segment (skipping bare-operator segments such as the
    // second `|` of `||`), not just `overlap` characters of it: a rule that
    // spans one operator (`tar … | <padding> curl`) would otherwise be missed
    // when the padding pushes its tail past the overlap at a window edge.
    let k = j;
    while (k < starts.length - 1 && (starts[k + 1] as number) - (starts[k] as number) <= 1) {
      k++;
    }
    const nextEnd = starts[Math.min(k + 1, starts.length - 1)] as number;
    windows.push(command.slice(from, Math.min(command.length, Math.max(to + overlap, nextEnd))));
    i = j;
  }
  return windows;
}

/**
 * Everything a blocking shell scan must look at: the command as written and,
 * when it differs, its {@link canonicalizeShellForScan} form — each split by
 * {@link shellScanWindows}. Duplicate windows are dropped.
 */
export function shellScanTargets(command: string): string[] {
  const out = new Set(shellScanWindows(command));
  const canonical = canonicalizeShellForScan(command);
  if (canonical !== command) {
    for (const w of shellScanWindows(canonical)) {
      out.add(w);
    }
  }
  return [...out];
}
