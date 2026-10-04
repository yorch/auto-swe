/** One changed field of a workflow node, shown as `+`, `−` or `~` in the diff view. */
export interface FieldChange {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Key-level difference between two node objects: only the fields that differ,
 * nested objects descended into with dotted paths. Arrays and scalars compare
 * as whole values.
 */
export function diffFields(before: unknown, after: unknown, prefix = ''): FieldChange[] {
  const out: FieldChange[] = [];
  const b = isPlainObject(before) ? before : {};
  const a = isPlainObject(after) ? after : {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const inB = key in b;
    const inA = key in a;
    if (inB && !inA) {
      out.push({ before: b[key], kind: 'removed', path });
    } else if (!inB && inA) {
      out.push({ after: a[key], kind: 'added', path });
    } else if (isPlainObject(b[key]) && isPlainObject(a[key])) {
      out.push(...diffFields(b[key], a[key], path));
    } else if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) {
      out.push({ after: a[key], before: b[key], kind: 'changed', path });
    }
  }
  return out;
}

/**
 * Orient a pair of versions so the lower number is "before" and the higher is
 * "after" — additions then read as additions. `reversed` flips that on purpose
 * (to see what rolling back would do).
 */
export function orientVersions(
  x: number,
  y: number,
  reversed = false
): { before: number; after: number } {
  const lo = Math.min(x, y);
  const hi = Math.max(x, y);
  return reversed ? { after: lo, before: hi } : { after: hi, before: lo };
}
