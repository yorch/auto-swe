export type DiffSide = 'LEFT' | 'RIGHT';

export type DiffAnchor = { line: number; side: DiffSide; startLine?: number | null };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const validNumber = (n: number): boolean => Number.isSafeInteger(n) && n >= 1;

/**
 * Whether a review comment can be anchored as described: `line` (and, for a range, `startLine`)
 * must be a row the patch shows on that side, and a range must lie inside one hunk, as the host
 * refuses one that spans hunks. RIGHT rows are added and context rows, numbered by the new file;
 * LEFT rows are deleted and context rows, numbered by the old file. A "\ No newline" marker is not
 * a row. A patch the host withheld anchors nothing.
 */
export function anchorInDiff(patch: string | undefined, a: DiffAnchor): boolean {
  if (!patch || !validNumber(a.line)) {
    return false;
  }
  const start = a.startLine ?? null;
  if (start !== null && (!validNumber(start) || start >= a.line)) {
    return false;
  }
  const rows = patch.split('\n');
  if (rows.at(-1) === '') {
    rows.pop();
  }
  let oldNext = 0;
  let newNext = 0;
  let inHunk = false;
  let sawStart = false;
  let sawEnd = false;
  const satisfied = () => sawEnd && (start === null || sawStart);
  for (const row of rows) {
    const header = HUNK.exec(row);
    if (header) {
      if (satisfied()) {
        return true;
      }
      oldNext = Number(header[1]);
      newNext = Number(header[2]);
      inHunk = true;
      sawStart = false;
      sawEnd = false;
      continue;
    }
    if (!inHunk || row.startsWith('\\')) {
      continue;
    }
    const kind = row.startsWith('-') ? '-' : row.startsWith('+') ? '+' : ' ';
    let number: number | null = null;
    if (a.side === 'LEFT' && kind !== '+') {
      number = oldNext;
    } else if (a.side === 'RIGHT' && kind !== '-') {
      number = newNext;
    }
    if (kind !== '+') {
      oldNext++;
    }
    if (kind !== '-') {
      newNext++;
    }
    if (number === a.line) {
      sawEnd = true;
    }
    if (number === start) {
      sawStart = true;
    }
  }
  return satisfied();
}
