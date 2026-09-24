/**
 * PATCH value for a nullable, non-secret config field whose input is prefilled
 * with the stored value:
 *
 *   - unchanged        → `undefined` (omitted from the body; the server keeps it)
 *   - cleared          → `null`      (the server clears the column)
 *   - anything else    → the trimmed new value
 *
 * Sending only non-empty values — the previous behaviour — made a stored value
 * impossible to clear from the UI (a GHE base URL, once set, stayed set).
 */
export function clearableField(
  draft: string,
  current: string | null | undefined
): string | null | undefined {
  const next = draft.trim();
  if (next === (current ?? '')) {
    return undefined;
  }
  return next === '' ? null : next;
}

/** `clearableField` for an integer input. An unparseable draft is left unchanged. */
export function clearableIntField(
  draft: string,
  current: number | null | undefined
): number | null | undefined {
  const next = draft.trim();
  if (next === '') {
    return current == null ? undefined : null;
  }
  const parsed = Number.parseInt(next, 10);
  if (Number.isNaN(parsed) || parsed === current) {
    return undefined;
  }
  return parsed;
}
