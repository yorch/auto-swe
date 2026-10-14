/** Guard against unbounded recursion on a hostile/cyclic in-memory object. */
const MAX_STRINGIFY_DEPTH = 100;

/**
 * Deterministic JSON: object keys sorted recursively so the hash is stable.
 *
 * Three properties this must keep, because every hash over it is a trust boundary (a bundle's
 * content hash, an assistant action's digest):
 * - `undefined`-valued keys are dropped (matches a JSON round-trip).
 * - `toJSON()` is honoured, so a `Date` canonicalizes to its ISO string rather
 *   than to `{}` — two different instants must never collide.
 * - Cycles throw instead of recursing forever (a cyclic value can only come
 *   from in-memory construction; a parsed one is always a tree).
 */
export function stableStringify(value: unknown, seen: Set<object> = new Set(), depth = 0): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (depth > MAX_STRINGIFY_DEPTH) {
    throw new Error('cannot canonicalize: object nested too deeply');
  }
  if (seen.has(value)) {
    throw new Error('cannot canonicalize: circular reference');
  }
  // `toJSON` first — Date/Decimal-like objects must serialize to their value,
  // not to `{}` (every Date would otherwise hash identically).
  const withToJson = value as { toJSON?: (key?: string) => unknown };
  if (typeof withToJson.toJSON === 'function') {
    return stableStringify(withToJson.toJSON(), seen, depth + 1);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((v) => stableStringify(v, seen, depth + 1)).join(',')}]`;
    }
    const obj = value as Record<string, unknown>;
    // Skip `undefined`-valued keys so the hash matches a JSON round-trip (JSON
    // and Zod `.optional()` reparse both DROP undefined keys — emitting them
    // would make an in-memory manifest hash differently from its posted form).
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const entries = keys.map(
      (k) => `${JSON.stringify(k)}:${stableStringify(obj[k], seen, depth + 1)}`
    );
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}
