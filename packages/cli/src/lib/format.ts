/** Shared CLI table-formatting + numeric-flag helpers. */

/** Left-pad a column value to a fixed width; truncate (with a trailing space)
 * when the value is longer. */
export function pad(s: string, w: number): string {
  if (s.length >= w) {
    return `${s.slice(0, w - 1)} `;
  }
  return s + ' '.repeat(w - s.length);
}

/**
 * Parse a positive integer flag value.
 *
 *   undefined        → `fallback` (default returned)
 *   'true' sentinel  → `'invalid'` (parseFlags' empty-value marker; the flag
 *                       was supplied without a number)
 *   non-numeric or ≤0 → `'invalid'`
 *   otherwise         → the parsed integer
 *
 * Callers print a usage hint + `return 1` on `'invalid'`.
 */
export function parsePositiveInt(raw: string | undefined, fallback: number): number | 'invalid' {
  const parsed = parseOptionalPositiveInt(raw);
  return parsed === undefined ? fallback : parsed;
}

/** Same as {@link parsePositiveInt} but treats a missing value as
 * `undefined` (instead of a fallback). Used by flags like `--version` where
 * "not specified" means "use the active version". */
export function parseOptionalPositiveInt(raw: string | undefined): number | undefined | 'invalid' {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === 'true') {
    return 'invalid';
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || String(n) !== raw.trim()) {
    return 'invalid';
  }
  return n;
}
