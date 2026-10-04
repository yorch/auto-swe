/**
 * A bounded line-based unified diff, for showing an admin what an upstream
 * update changes in a skill's text.
 *
 * It is Myers' O(ND) algorithm, so its cost follows how much changed, not how
 * long the texts are, and it is bounded two ways: a per-diff cap on the edit
 * distance (`maxEdits`) and a work budget that one request shares across every
 * skill. Past either, the diff is reported `tooLarge` instead of computed: a
 * partial or approximate diff would show a reviewer something other than what
 * an accept installs. Removed and added lines come out interleaved in file
 * order, as in any unified diff.
 */

export const MAX_DIFF_EDITS = 1000;
export const MAX_DIFF_CHARS = 60_000;
/** Inner-loop steps one request may spend across all its skills (~100 ms of CPU). */
export const DIFF_WORK_BUDGET = 20_000_000;

export interface DiffBudget {
  left: number;
}

export interface TextDiff {
  /** The unified diff, cut at `maxChars`; '' when equal or `tooLarge`. */
  text: string;
  /** The diff was longer than `maxChars` and the rest is not included. */
  truncated: boolean;
  /** Not computed: more than `maxEdits` lines differ, or the request's work budget ran out. */
  tooLarge: boolean;
}

type Op = { kind: ' ' | '-' | '+'; text: string };

/** Myers shortest edit script over `a` and `b`; null when it needs more than `maxEdits` edits. */
function myers(a: string[], b: string[], maxEdits: number, budget: DiffBudget): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const o = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] is the window of `v` (diagonals -d-1 .. d+1) before round d.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(o - d - 1, o + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[o + k - 1] as number) < (v[o + k + 1] as number))
          ? (v[o + k + 1] as number)
          : (v[o + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
        budget.left--;
      }
      v[o + k] = x;
      budget.left--;
      if (x >= n && y >= m) {
        return backtrack(a, b, trace, d);
      }
    }
    if (budget.left < 0) {
      return null;
    }
  }
  return null;
}

function backtrack(a: string[], b: string[], trace: Int32Array[], dEnd: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const vv = trace[d] as Int32Array;
    const at = (k: number) => vv[k + d + 1] as number;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    const xs = down ? prevX : prevX + 1;
    const ys = xs - k;
    while (x > xs && y > ys) {
      ops.push({ kind: ' ', text: a[x - 1] as string });
      x--;
      y--;
    }
    ops.push(down ? { kind: '+', text: b[y - 1] as string } : { kind: '-', text: a[x - 1] as string });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: ' ', text: a[x - 1] as string });
    x--;
    y--;
  }
  return ops.reverse();
}

/** Unified diff of two texts with `context` lines around each change. */
export function unifiedDiff(
  oldText: string,
  newText: string,
  opts: {
    context?: number;
    maxChars?: number;
    maxEdits?: number;
    budget?: DiffBudget;
  } = {}
): TextDiff {
  const context = opts.context ?? 3;
  const maxChars = opts.maxChars ?? MAX_DIFF_CHARS;
  if (oldText === newText) {
    return { text: '', tooLarge: false, truncated: false };
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
  const middle = myers(
    a.slice(head, a.length - tail),
    b.slice(head, b.length - tail),
    opts.maxEdits ?? MAX_DIFF_EDITS,
    opts.budget ?? { left: DIFF_WORK_BUDGET }
  );
  if (middle === null) {
    return { text: '', tooLarge: true, truncated: false };
  }
  const ops: Op[] = [
    ...a.slice(0, head).map((text): Op => ({ kind: ' ', text })),
    ...middle,
    ...a.slice(a.length - tail).map((text): Op => ({ kind: ' ', text })),
  ];

  // Line numbers before each op, so a hunk header needs no rescan.
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let oi = 0;
  let ni = 0;
  for (const op of ops) {
    oldBefore.push(oi);
    newBefore.push(ni);
    if (op.kind !== '+') {
      oi++;
    }
    if (op.kind !== '-') {
      ni++;
    }
  }
  const changed = ops.flatMap((op, i) => (op.kind === ' ' ? [] : [i]));
  const out: string[] = [];
  let size = 0;
  let truncated = false;
  const push = (line: string): boolean => {
    if (size + line.length + 1 > maxChars) {
      truncated = true;
      return false;
    }
    out.push(line);
    size += line.length + 1;
    return true;
  };
  let k = 0;
  while (k < changed.length && !truncated) {
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
    const oldLen = slice.filter((o) => o.kind !== '+').length;
    const newLen = slice.filter((o) => o.kind !== '-').length;
    const header = `@@ -${(oldBefore[from] as number) + 1},${oldLen} +${(newBefore[from] as number) + 1},${newLen} @@`;
    if (push(header)) {
      for (const op of slice) {
        if (!push(`${op.kind}${op.text}`)) {
          break;
        }
      }
    }
    k = end + 1;
  }
  return { text: out.join('\n'), tooLarge: false, truncated };
}
