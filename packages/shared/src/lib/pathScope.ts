/**
 * The path-scope grammar of orchestrated writer children (`orchestration.ts` re-exports it).
 *
 * A leaf module: pure, dependency-free and isolate-safe, so `agentRun.ts` (whose launch payload
 * carries scopes) and `orchestration.ts` (which defines the intents and the overlap rule) share one
 * parser without importing each other. Nothing here throws on any input.
 */

export const PATH_SCOPE_MAX_LENGTH = 200;
export const PATH_SCOPES_MAX = 20;

/**
 * A parsed scope. `path` is the directory for `tree` (`src/lib/**` has path `src/lib`), the whole
 * pattern for `dir` (`src/*.ts`), and the file path for `file`.
 */
export type ParsedScope = { kind: 'tree' | 'dir' | 'file'; path: string };

export type ParseScopeResult = { ok: true; scope: ParsedScope } | { ok: false; reason: string };

/**
 * Code points that belong in no repository path and in no attribute a reviewer is meant to read:
 * C0/C1 controls, soft hyphen, bidi controls, zero-width and invisible-filler characters, variation
 * selectors, the tag block (U+E0000 to U+E007F) and lone surrogates. Judged by code point, so an
 * astral invisible cannot hide in a surrogate pair, and the source carries no literal controls.
 * `keepWhitespace` lets tab, newline and carriage return through, for free text.
 */
export function isUnsafeCodePoint(c: number, keepWhitespace: boolean): boolean {
  if (keepWhitespace && (c === 0x0a || c === 0x09 || c === 0x0d)) {
    return false;
  }
  return (
    c <= 0x1f ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0xad ||
    c === 0x034f ||
    c === 0x061c ||
    c === 0x115f ||
    c === 0x1160 ||
    (c >= 0x180b && c <= 0x180f) ||
    (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x2028 && c <= 0x202e) ||
    (c >= 0x2060 && c <= 0x206f) ||
    c === 0x3164 ||
    (c >= 0xd800 && c <= 0xdfff) ||
    (c >= 0xfe00 && c <= 0xfe0f) ||
    c === 0xfeff ||
    c === 0xffa0 ||
    (c >= 0xfff9 && c <= 0xfffb) ||
    (c >= 0xe0000 && c <= 0xe007f) ||
    (c >= 0xe0100 && c <= 0xe01ef)
  );
}

export function hasUnsafeChars(value: string, keepWhitespace = false): boolean {
  for (const ch of value) {
    if (isUnsafeCodePoint(ch.codePointAt(0) as number, keepWhitespace)) {
      return true;
    }
  }
  return false;
}

export function stripUnsafeChars(value: string, keepWhitespace: boolean): string {
  let out = '';
  for (const ch of value) {
    if (!isUnsafeCodePoint(ch.codePointAt(0) as number, keepWhitespace)) {
      out += ch;
    }
  }
  return out;
}

const GLOB_CHARS_RE = /[*?[\]{}]/;
const DIR_GLOB_FILE_RE = /^\*(\.[A-Za-z0-9_-]+)*$/;
const WHITESPACE_RE = /\s/u;

export function nfc(value: string): string {
  return value.normalize('NFC');
}

export function parsePathScope(raw: string): ParseScopeResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'scope must be a string' };
  }
  if (raw.length === 0) {
    return { ok: false, reason: 'scope is empty' };
  }
  if (raw.length > PATH_SCOPE_MAX_LENGTH) {
    return { ok: false, reason: `scope is longer than ${PATH_SCOPE_MAX_LENGTH} characters` };
  }
  if (hasUnsafeChars(raw)) {
    return { ok: false, reason: 'scope contains a control character' };
  }
  if (raw !== raw.trim()) {
    return { ok: false, reason: 'scope has leading or trailing whitespace' };
  }
  if (WHITESPACE_RE.test(raw)) {
    return { ok: false, reason: 'scope contains whitespace' };
  }
  if (raw.includes('\\')) {
    return { ok: false, reason: 'scope contains a backslash' };
  }
  if (raw.startsWith('/')) {
    return { ok: false, reason: 'scope is an absolute path' };
  }
  const scope = nfc(raw);
  const segments = scope.split('/');
  if (segments.some((s) => s === '')) {
    return { ok: false, reason: 'scope has an empty segment or a trailing slash' };
  }
  if (segments.some((s) => s === '..')) {
    return { ok: false, reason: 'scope contains ..' };
  }
  if (segments.some((s) => s === '.')) {
    return { ok: false, reason: 'scope contains a . segment' };
  }
  if (/^[A-Za-z]:$/.test(segments[0] ?? '')) {
    return { ok: false, reason: 'scope looks like a drive path' };
  }

  const last = segments[segments.length - 1] as string;
  const parents = segments.slice(0, -1);
  if (parents.some((s) => GLOB_CHARS_RE.test(s))) {
    return { ok: false, reason: 'a wildcard is only allowed in the last segment' };
  }

  if (last === '**') {
    if (parents.length === 0) {
      return { ok: false, reason: '** needs a directory in front of it' };
    }
    return { ok: true, scope: { kind: 'tree', path: parents.join('/') } };
  }
  if (last.includes('**')) {
    return { ok: false, reason: '** is only allowed as a whole last segment' };
  }
  if (GLOB_CHARS_RE.test(last)) {
    if (!DIR_GLOB_FILE_RE.test(last)) {
      return { ok: false, reason: 'the only glob form is * or *.ext in the last segment' };
    }
    return { ok: true, scope: { kind: 'dir', path: scope } };
  }
  return { ok: true, scope: { kind: 'file', path: scope } };
}

/**
 * Whether `scope` is exactly what `parsePathScope` would have produced: right kind for its path,
 * NFC, no wildcard outside the last segment, a `dir` glob whose base starts with `*`. A scope that
 * fails is malformed (hand-built, or read back from a corrupted row) and callers fail closed on it.
 * Never throws, whatever the input.
 */
export function isWellFormedScope(scope: unknown): scope is ParsedScope {
  try {
    if (typeof scope !== 'object' || scope === null) {
      return false;
    }
    const { kind, path } = scope as { kind?: unknown; path?: unknown };
    if (typeof path !== 'string' || (kind !== 'tree' && kind !== 'dir' && kind !== 'file')) {
      return false;
    }
    if (nfc(path) !== path) {
      return false;
    }
    const parsed = parsePathScope(kind === 'tree' ? `${path}/**` : path);
    return parsed.ok && parsed.scope.kind === kind && parsed.scope.path === path;
  } catch {
    return false;
  }
}
