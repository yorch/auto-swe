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
