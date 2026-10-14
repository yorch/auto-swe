/**
 * JSON Pointer (RFC 6901), read-only: where in an inbound event a value is found
 * (docs/inbound-events.md). `''` is the whole document; every other pointer starts with `/`,
 * and in each segment `~1` stands for `/` and `~0` for `~`. Array elements are addressed by
 * their decimal index without leading zeros; `-` (one past the end) never resolves.
 *
 * Pure and dependency-free: the gateway extracts with it and the dashboard's tester answers with
 * the same code.
 */

/** The longest pointer accepted; a real one is a few dozen characters. */
export const MAX_JSON_POINTER_LENGTH = 256;
/** The most segments a pointer may have. */
const MAX_SEGMENTS = 32;
const ARRAY_INDEX_RE = /^(?:0|[1-9][0-9]{0,8})$/;

/** The pointer's reference tokens, unescaped; null when it is not a valid pointer. */
export function parseJsonPointer(pointer: string): string[] | null {
  if (pointer === '') {
    return [];
  }
  if (!pointer.startsWith('/') || pointer.length > MAX_JSON_POINTER_LENGTH) {
    return null;
  }
  const raw = pointer.slice(1).split('/');
  if (raw.length > MAX_SEGMENTS) {
    return null;
  }
  const out: string[] = [];
  for (const token of raw) {
    // `~` must be followed by `0` or `1`; anything else is not a pointer.
    if (/~(?![01])/.test(token)) {
      return null;
    }
    // `~1` first, then `~0`: `~01` is the text `~1`, not `/`.
    out.push(token.replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  return out;
}

/** Whether `pointer` is a valid JSON Pointer this module accepts. */
export function isJsonPointer(pointer: string): boolean {
  return parseJsonPointer(pointer) !== null;
}

/** A pointer from tokens, escaped: the inverse of `parseJsonPointer`. */
export function formatJsonPointer(tokens: readonly string[]): string {
  return tokens.map((t) => `/${t.replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

export type JsonPointerResult = { found: true; value: unknown } | { found: false };

/**
 * The value `pointer` names in `doc`, or not found: a missing key, an index out of range or not
 * written as one, `-`, a step into a scalar, or an invalid pointer. Only a document's own keys
 * are followed, never an inherited property (`/constructor`, `/__proto__`).
 */
export function resolveJsonPointer(doc: unknown, pointer: string): JsonPointerResult {
  const tokens = parseJsonPointer(pointer);
  if (tokens === null) {
    return { found: false };
  }
  let current: unknown = doc;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX_RE.test(token)) {
        return { found: false };
      }
      const index = Number(token);
      if (index >= current.length) {
        return { found: false };
      }
      current = current[index];
    } else if (current !== null && typeof current === 'object') {
      if (!Object.hasOwn(current, token)) {
        return { found: false };
      }
      current = (current as Record<string, unknown>)[token];
    } else {
      return { found: false };
    }
  }
  return current === undefined ? { found: false } : { found: true, value: current };
}
