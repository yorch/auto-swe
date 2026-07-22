/**
 * Parse an optional positive-integer text input (shared by the admin config
 * forms that expose nullable "override, else built-in default" number fields).
 *
 * - `''` (blank, after trim) → `null` — the caller decides whether null means
 *   "clear the override" (PATCH) or "omit the field" (create).
 * - a strict positive integer (`>= 1`, no decimals / leading zeros / signs) →
 *   the number.
 * - anything else → `undefined`, signalling a validation error the caller
 *   should surface instead of submitting.
 */
export function parseOptionalPositiveInt(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  const num = Number.parseInt(trimmed, 10);
  if (Number.isNaN(num) || num < 1 || String(num) !== trimmed) {
    return undefined;
  }
  return num;
}
