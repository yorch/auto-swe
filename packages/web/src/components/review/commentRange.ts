import type { ParsedDiffLine } from '@/components/approvals/diffParse';

export type CommentSide = 'LEFT' | 'RIGHT';

/** What a comment is anchored to: `line` is the last line of a range, `startLine` the first. */
export type CommentAnchor = { line: number; side: CommentSide; startLine: number | null };

/**
 * Which hunk of a patch holds a line, counted from zero, or null when the side has no such line.
 * RIGHT lines are the added and unchanged ones, numbered by the new file; LEFT lines are the removed
 * ones, numbered by the old file.
 */
function hunkOf(lines: readonly ParsedDiffLine[], side: CommentSide, no: number): number | null {
  let hunk = -1;
  for (const line of lines) {
    if (line.kind === 'hunk') {
      hunk += 1;
    } else if (side === 'RIGHT') {
      if ((line.kind === 'add' || line.kind === 'ctx') && line.newNo === no) {
        return hunk;
      }
    } else if (line.kind === 'del' && line.oldNo === no) {
      return hunk;
    }
  }
  return null;
}

/**
 * The anchor for a click on `line`. A Shift-click that extends an open editor on the same side, at
 * a different line of the same hunk, makes a range (first line to last); in every other case the
 * click is a plain single-line comment on the clicked line.
 */
export function anchorForClick(
  lines: readonly ParsedDiffLine[] | undefined,
  open: CommentAnchor | null,
  side: CommentSide,
  line: number,
  shift: boolean
): CommentAnchor {
  const single: CommentAnchor = { line, side, startLine: null };
  if (!shift || open === null || open.side !== side || !lines) {
    return single;
  }
  // The editor's own origin: the first line of its range, or its only line.
  const origin = open.startLine ?? open.line;
  if (origin === line) {
    return single;
  }
  const from = hunkOf(lines, side, origin);
  const to = hunkOf(lines, side, line);
  if (from === null || from !== to) {
    return single;
  }
  return { line: Math.max(origin, line), side, startLine: Math.min(origin, line) };
}

/** The wording shared by the editor's label and a saved draft: 'line 12', 'deleted lines 8–10'. */
export function anchorLabel({ line, side, startLine }: CommentAnchor): string {
  const noun = side === 'LEFT' ? 'deleted line' : 'line';
  return startLine === null ? `${noun} ${line}` : `${noun}s ${startLine}–${line}`;
}
