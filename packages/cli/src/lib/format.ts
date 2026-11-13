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

// An emoji renders as one: a variation selector after a pictograph (not (c), (r), TM), a keycap's
// selector and a joiner between two pictographs are left alone; the rest is replaced or shown.
const CONTROL =
  /(?!(?:(?<=[0-9#*])\uFE0F(?=\u20E3)|(?<=[\p{Emoji_Presentation}\p{Extended_Pictographic}])(?<![\u00A9\u00AE\u2122])[\uFE0E\uFE0F]))(?!(?<=\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}]?\uFE0F?)\u200D(?=\p{Extended_Pictographic}))[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

/** Replace control and invisible characters so server text cannot drive the terminal. */
export const clean = (s: string): string => s.replace(CONTROL, '?');
