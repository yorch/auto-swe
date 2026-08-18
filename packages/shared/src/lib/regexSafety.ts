/**
 * Static safety analysis for operator- and bundle-supplied regular expressions.
 *
 * Scanner patterns are DATA: admins add them at `/admin/scanner`, and installed
 * bundles carry them. Their bodies are compiled with `new RegExp` and `.test()`-run
 * in-process against agent text (skill `promptText` on every save, LLM output on
 * every TDD iteration). JavaScript's backtracking engine has no execution budget
 * and a running regex cannot be interrupted, so a catastrophic pattern like
 * `(a+)+$` is a self-inflicted denial of service on the gateway or worker.
 *
 * There is no RE2 binding in this repo's dependency set and adding a native one is
 * out of proportion to the threat (patterns are admin-authored, not anonymous
 * input), so the defence is two cheap layers instead:
 *
 * 1. **Write-time rejection** — {@link checkRegexSafety} refuses a pattern whose
 *    structure admits exponential backtracking, at BOTH entry points (the admin
 *    API and bundle install), so an unverified bundle cannot smuggle one in.
 * 2. **Read-time bounding** — {@link capScanText} caps how much text any single
 *    pattern is run over, which bounds the polynomial (quadratic) blow-ups that
 *    structural analysis cannot see, and covers patterns already in the DB from
 *    before this check existed.
 *
 * The analysis is a *heuristic*, deliberately biased toward accepting: it flags
 * the two structures that actually produce exponential behaviour (a nested
 * unbounded quantifier that can consume its own group's first characters, and an
 * unbounded-quantified alternation whose branches can start on the same
 * character) and lets everything else through. It raises the floor; it is not a
 * containment boundary.
 */

/** Mirrors the admin API's body cap; enforced here so bundle install shares it. */
export const MAX_PATTERN_SOURCE_LENGTH = 2000;

/**
 * Hard cap on the text any one scanner pattern is run over. Scanning is advisory
 * everywhere it is used, so truncating is strictly better than an unbounded run:
 * a quadratic pattern over an unbounded LLM response can stall an activity for
 * minutes, while a missed match past 20k characters only loses a warning.
 */
export const MAX_SCAN_TEXT_LENGTH = 20_000;

/** Safe flag subset — `g`/`y` are stateful (`lastIndex`) on a cached RegExp. */
const SAFE_FLAGS_RE = /^[imsuv]*$/;

export type RegexSafetyCode = 'INVALID_REGEX' | 'UNSAFE_FLAGS' | 'PATTERN_TOO_LONG' | 'REDOS_RISK';

export interface RegexSafetyIssue {
  code: RegexSafetyCode;
  message: string;
}

/**
 * Validate a pattern body + flags for use as a scanner pattern. Returns `null`
 * when the pattern is acceptable, or a single actionable issue.
 */
export function checkRegexSafety(pattern: string, flags = ''): RegexSafetyIssue | null {
  if (pattern.length > MAX_PATTERN_SOURCE_LENGTH) {
    return {
      code: 'PATTERN_TOO_LONG',
      message: `pattern is ${pattern.length} characters; the maximum is ${MAX_PATTERN_SOURCE_LENGTH}`,
    };
  }
  if (!SAFE_FLAGS_RE.test(flags)) {
    return {
      code: 'UNSAFE_FLAGS',
      message: "flags may only contain i, m, s, u, v — 'g' and 'y' are not allowed",
    };
  }
  try {
    new RegExp(pattern, flags);
  } catch (err) {
    return {
      code: 'INVALID_REGEX',
      message: err instanceof Error ? err.message : 'Invalid regular expression',
    };
  }
  const risk = findBacktrackingRisk(pattern, flags);
  if (risk) {
    return {
      code: 'REDOS_RISK',
      message:
        `pattern rejected as vulnerable to catastrophic backtracking: ${risk}. ` +
        'Rewrite it without a quantifier nested inside an unbounded-repeated group ' +
        '(e.g. `(a+)+` → `a+`), and make repeated alternation branches start on ' +
        'distinct characters.',
    };
  }
  return null;
}

/** Convenience predicate for write-time checks. */
export function isRegexSafe(pattern: string, flags = ''): boolean {
  return checkRegexSafety(pattern, flags) === null;
}

/**
 * The load-time variant: reports only the issues that make a stored pattern
 * dangerous to RUN (it will not compile, or it can backtrack catastrophically).
 *
 * Write-time-only policies are deliberately NOT reported here. Dropping a stored
 * rule because its body is over the length cap, or because it carries `g`/`y`,
 * would fail open — the admin's block rule would silently stop applying — and
 * the scanners already reset `lastIndex` before every use, which is what makes a
 * stateful flag harmless at read time.
 */
export function checkRegexRuntimeSafety(pattern: string, flags = ''): RegexSafetyIssue | null {
  // Strip stateful flags rather than rejecting on them, so the compile and
  // backtracking analysis below still run for such a row.
  const issue = checkRegexSafety(pattern, flags.replace(/[gy]/g, ''));
  if (!issue) {
    return null;
  }
  return issue.code === 'INVALID_REGEX' || issue.code === 'REDOS_RISK' ? issue : null;
}

/** Truncate text to the per-pattern scan cap (see {@link MAX_SCAN_TEXT_LENGTH}). */
export function capScanText(text: string): string {
  return text.length > MAX_SCAN_TEXT_LENGTH ? text.slice(0, MAX_SCAN_TEXT_LENGTH) : text;
}

// ── Minimal regex parser ────────────────────────────────────────────────────
// Just enough structure to answer "can this group's repetition be ambiguous?".
// Not a validator: the pattern has already been compiled by `new RegExp` above.

interface Quantifier {
  min: number;
  max: number;
}

interface Atom {
  kind: 'char' | 'class' | 'group';
  /** Matchable source for char/class atoms (used to sample the character set). */
  source: string;
  /** Parsed body for group atoms. */
  body: Alternation;
  /** Anchors and lookarounds consume nothing, so they never start a match. */
  zeroWidth: boolean;
  quant: Quantifier | null;
}

type Sequence = Atom[];
type Alternation = Sequence[];

const MAX_PARSE_DEPTH = 20;

class ParseTooDeep extends Error {}

function parseAlternation(
  src: string,
  start: number,
  depth: number
): { alts: Alternation; end: number } {
  if (depth > MAX_PARSE_DEPTH) {
    throw new ParseTooDeep('regex nests groups too deeply to analyse');
  }
  const alts: Alternation = [];
  let seq: Sequence = [];
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ')') {
      break;
    }
    if (ch === '|') {
      alts.push(seq);
      seq = [];
      i++;
      continue;
    }
    let atom: Atom;
    if (ch === '(') {
      const open = readGroupPrefix(src, i);
      const inner = parseAlternation(src, open.bodyStart, depth + 1);
      atom = {
        body: inner.alts,
        kind: 'group',
        quant: null,
        source: src.slice(i, inner.end + 1),
        zeroWidth: open.zeroWidth,
      };
      i = src[inner.end] === ')' ? inner.end + 1 : inner.end;
    } else if (ch === '[') {
      const end = readClassEnd(src, i);
      atom = {
        body: [],
        kind: 'class',
        quant: null,
        source: src.slice(i, end + 1),
        zeroWidth: false,
      };
      i = end + 1;
    } else if (ch === '\\') {
      const end = readEscapeEnd(src, i);
      const source = src.slice(i, end + 1);
      atom = {
        body: [],
        kind: 'char',
        quant: null,
        source,
        zeroWidth: source === '\\b' || source === '\\B',
      };
      i = end + 1;
    } else if (ch === '^' || ch === '$') {
      atom = { body: [], kind: 'char', quant: null, source: ch, zeroWidth: true };
      i++;
    } else {
      atom = {
        body: [],
        kind: 'char',
        quant: null,
        source: escapeLiteral(ch as string),
        zeroWidth: false,
      };
      i++;
    }
    const q = readQuantifier(src, i);
    atom.quant = q.quant;
    i = q.end;
    seq.push(atom);
  }
  alts.push(seq);
  return { alts, end: i };
}

/** Classify `(`, `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<name>` and find the body start. */
function readGroupPrefix(src: string, i: number): { bodyStart: number; zeroWidth: boolean } {
  if (src[i + 1] !== '?') {
    return { bodyStart: i + 1, zeroWidth: false };
  }
  const two = src.slice(i + 2, i + 3);
  if (two === ':') {
    return { bodyStart: i + 3, zeroWidth: false };
  }
  if (two === '=' || two === '!') {
    return { bodyStart: i + 3, zeroWidth: true };
  }
  if (two === '<') {
    const three = src.slice(i + 3, i + 4);
    if (three === '=' || three === '!') {
      return { bodyStart: i + 4, zeroWidth: true };
    }
    const close = src.indexOf('>', i + 3);
    return { bodyStart: close === -1 ? i + 3 : close + 1, zeroWidth: false };
  }
  return { bodyStart: i + 2, zeroWidth: false };
}

function readClassEnd(src: string, i: number): number {
  let j = i + 1;
  if (src[j] === '^') {
    j++;
  }
  if (src[j] === ']') {
    j++; // a `]` in first position is a literal
  }
  while (j < src.length) {
    if (src[j] === '\\') {
      j += 2;
      continue;
    }
    if (src[j] === ']') {
      return j;
    }
    j++;
  }
  return src.length - 1;
}

function readEscapeEnd(src: string, i: number): number {
  const next = src[i + 1];
  // `\u{...}` and `\p{...}` / `\P{...}` carry a braced argument.
  if ((next === 'u' || next === 'p' || next === 'P') && src[i + 2] === '{') {
    const close = src.indexOf('}', i + 3);
    return close === -1 ? i + 1 : close;
  }
  if (next === 'u') {
    return Math.min(i + 5, src.length - 1);
  }
  if (next === 'x') {
    return Math.min(i + 3, src.length - 1);
  }
  return i + 1;
}

function readQuantifier(src: string, i: number): { quant: Quantifier | null; end: number } {
  const ch = src[i];
  let quant: Quantifier | null = null;
  let end = i;
  if (ch === '*') {
    quant = { max: Number.POSITIVE_INFINITY, min: 0 };
    end = i + 1;
  } else if (ch === '+') {
    quant = { max: Number.POSITIVE_INFINITY, min: 1 };
    end = i + 1;
  } else if (ch === '?') {
    quant = { max: 1, min: 0 };
    end = i + 1;
  } else if (ch === '{') {
    const close = src.indexOf('}', i);
    const inner = close === -1 ? '' : src.slice(i + 1, close);
    const m = /^(\d+)(,(\d*)?)?$/.exec(inner);
    if (m) {
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] ? Number(m[3]) : Number.POSITIVE_INFINITY;
      quant = { max, min };
      end = close + 1;
    }
  }
  if (quant && (src[end] === '?' || src[end] === '+')) {
    end++; // lazy / possessive modifier — irrelevant to ambiguity
  }
  return { end, quant };
}

function escapeLiteral(ch: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch;
}

// ── Character-set sampling ──────────────────────────────────────────────────
// Sets are compared by testing a representative alphabet: exact enough to tell
// `[a-z]+` from `\s+` (which is all the overlap rules need) and far simpler
// than a real character-class algebra.

const BASE_ALPHABET = [...'abzABZ019 \t\n_-./\\:;,@#$%&*+=?!|<>()[]{}"\'`~^', 'é'];

/** Regex syntax characters that are never themselves a literal in the source. */
const META_CHARS = new Set([...'\\^$.|?*+()[]{}']);

interface Ctx {
  alphabet: string[];
  flags: string;
}

/**
 * The base alphabet plus every literal character the pattern itself mentions —
 * without this, sampling would report an empty set for `x+` (no `x` in the base
 * alphabet) and miss the overlap in `(x+)+`.
 */
function makeCtx(pattern: string, flags: string): Ctx {
  const chars = new Set(BASE_ALPHABET);
  for (const ch of pattern) {
    if (!META_CHARS.has(ch)) {
      chars.add(ch);
    }
  }
  return { alphabet: [...chars], flags };
}

function sampleSet(source: string, ctx: Ctx): Set<string> {
  const attempt = (f: string): Set<string> | null => {
    try {
      const re = new RegExp(`^(?:${source})$`, f);
      return new Set(ctx.alphabet.filter((c) => re.test(c)));
    } catch {
      return null;
    }
  };
  const scanFlags = ctx.flags.replace(/[my]/g, '');
  return attempt(scanFlags) ?? attempt('') ?? new Set(ctx.alphabet);
}

function charsOf(atom: Atom, ctx: Ctx, depth: number): Set<string> {
  if (atom.kind === 'group') {
    if (depth > MAX_PARSE_DEPTH) {
      return new Set(ctx.alphabet);
    }
    const out = new Set<string>();
    for (const seq of atom.body) {
      for (const c of firstSet(seq, ctx, depth + 1)) {
        out.add(c);
      }
    }
    return out;
  }
  return sampleSet(atom.source, ctx);
}

/** Characters a sequence can begin a match with (skipping nullable/zero-width atoms). */
function firstSet(seq: Sequence, ctx: Ctx, depth: number): Set<string> {
  const out = new Set<string>();
  for (const atom of seq) {
    if (atom.zeroWidth) {
      continue;
    }
    for (const c of charsOf(atom, ctx, depth)) {
      out.add(c);
    }
    if (!atom.quant || atom.quant.min >= 1) {
      break; // this atom must consume at least one character
    }
  }
  return out;
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
  for (const c of a) {
    if (b.has(c)) {
      return true;
    }
  }
  return false;
}

/** Unbounded-repeated atoms at this level, seeing through unquantified groups. */
function unboundedAtoms(seq: Sequence, depth: number): Atom[] {
  const out: Atom[] = [];
  for (const atom of seq) {
    if (atom.zeroWidth) {
      continue;
    }
    if (atom.quant && atom.quant.max === Number.POSITIVE_INFINITY) {
      out.push(atom);
    } else if (atom.kind === 'group' && !atom.quant && depth < MAX_PARSE_DEPTH) {
      for (const inner of atom.body) {
        out.push(...unboundedAtoms(inner, depth + 1));
      }
    }
  }
  return out;
}

/**
 * Returns a description of the first catastrophic-backtracking risk found, or
 * `null`. Two rules, both scoped to groups carrying an unbounded quantifier:
 *
 * - **Nested ambiguous repetition** — an inner unbounded quantifier whose
 *   character set overlaps the characters the group itself can start with, so
 *   one input can be split across iterations exponentially many ways (`(a+)+`,
 *   `(\s*\w+)*`). A group like `(?:-[a-z]+\s+)*` is NOT flagged: its iterations
 *   must start on `-`, which neither inner quantifier can match, so the split is
 *   unambiguous — this precision is why a plain star-height check is not used.
 * - **Ambiguous repeated alternation** — two branches of an unbounded-repeated
 *   group that can begin on the same character (`(a|ab)+`), while a disjoint one
 *   like `(foo|bar)+` passes.
 */
function findBacktrackingRisk(pattern: string, flags: string): string | null {
  let alts: Alternation;
  try {
    alts = parseAlternation(pattern, 0, 0).alts;
  } catch (err) {
    if (err instanceof ParseTooDeep) {
      return err.message;
    }
    return null; // never let the analyser itself reject a compilable pattern
  }
  return inspect(alts, makeCtx(pattern, flags), 0);
}

function inspect(alts: Alternation, ctx: Ctx, depth: number): string | null {
  if (depth > MAX_PARSE_DEPTH) {
    return null;
  }
  for (const seq of alts) {
    for (const atom of seq) {
      if (atom.kind !== 'group') {
        continue;
      }
      if (!atom.zeroWidth && atom.quant?.max === Number.POSITIVE_INFINITY) {
        const risk = inspectRepeatedGroup(atom, ctx, depth);
        if (risk) {
          return risk;
        }
      }
      const nested = inspect(atom.body, ctx, depth + 1);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function inspectRepeatedGroup(group: Atom, ctx: Ctx, depth: number): string | null {
  // Rule 1 — nested unbounded quantifier that can eat the group's own prefix.
  for (const seq of group.body) {
    const first = firstSet(seq, ctx, depth + 1);
    if (first.size === 0) {
      continue;
    }
    for (const inner of unboundedAtoms(seq, depth + 1)) {
      if (overlaps(charsOf(inner, ctx, depth + 1), first)) {
        return `unbounded quantifier nested inside the repeated group ${group.source}`;
      }
    }
  }
  // Rule 2 — repeated alternation whose branches can start on the same character.
  if (group.body.length > 1) {
    const sets = group.body.map((seq) => firstSet(seq, ctx, depth + 1));
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const a = sets[i];
        const b = sets[j];
        if (a && b && overlaps(a, b)) {
          return `alternation branches of the repeated group ${group.source} can start on the same character`;
        }
      }
    }
  }
  return null;
}
