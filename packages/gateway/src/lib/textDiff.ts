/**
 * A line-based unified diff, for showing an admin what an upstream update
 * changes in a skill's text. Skill text is bounded (50 000 characters), so a
 * quadratic LCS over the lines that differ is enough; past `MAX_CELLS` it falls
 * back to one hunk that replaces the whole middle, which is still a correct diff.
 */

const MAX_CELLS = 4_000_000;

type Op = { kind: ' ' | '-' | '+'; text: string };

function lcsOps(a: string[], b: string[]): Op[] {
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text): Op => ({ kind: '-', text })),
      ...b.map((text): Op => ({ kind: '+', text })),
    ];
  }
  const w = b.length + 1;
  const table = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * w + j] =
        a[i] === b[j]
          ? (table[(i + 1) * w + j + 1] as number) + 1
          : Math.max(table[(i + 1) * w + j] as number, table[i * w + j + 1] as number);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i] as string });
      i++;
      j++;
    } else if ((table[(i + 1) * w + j] as number) >= (table[i * w + j + 1] as number)) {
      ops.push({ kind: '-', text: a[i++] as string });
    } else {
      ops.push({ kind: '+', text: b[j++] as string });
    }
  }
  while (i < a.length) {
    ops.push({ kind: '-', text: a[i++] as string });
  }
  while (j < b.length) {
    ops.push({ kind: '+', text: b[j++] as string });
  }
  return ops;
}

/** Unified diff of two texts with `context` lines around each change; '' when they are equal. */
export function unifiedDiff(oldText: string, newText: string, context = 3): string {
  if (oldText === newText) {
    return '';
  }
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head++;
  }
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const ops: Op[] = [
    ...a.slice(0, head).map((text): Op => ({ kind: ' ', text })),
    ...lcsOps(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map((text): Op => ({ kind: ' ', text })),
  ];

  const changed = ops.flatMap((op, i) => (op.kind === ' ' ? [] : [i]));
  const out: string[] = [];
  let k = 0;
  while (k < changed.length) {
    // One hunk spans changes whose gap is no wider than twice the context.
    let end = k;
    while (
      end + 1 < changed.length &&
      (changed[end + 1] as number) - (changed[end] as number) <= 2 * context + 1
    ) {
      end++;
    }
    const from = Math.max(0, (changed[k] as number) - context);
    const to = Math.min(ops.length, (changed[end] as number) + context + 1);
    const slice = ops.slice(from, to);
    const oldStart = ops.slice(0, from).filter((o) => o.kind !== '+').length + 1;
    const newStart = ops.slice(0, from).filter((o) => o.kind !== '-').length + 1;
    const oldLen = slice.filter((o) => o.kind !== '+').length;
    const newLen = slice.filter((o) => o.kind !== '-').length;
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`);
    for (const op of slice) {
      out.push(`${op.kind}${op.text}`);
    }
    k = end + 1;
  }
  return out.join('\n');
}
