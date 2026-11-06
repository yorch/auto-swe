import type { ParsedDiffLine } from '../approvals/diffParse';

/** One side of a split row: a removed, added or unchanged line, without its leading marker. */
export type DiffCell = {
  kind: 'add' | 'del' | 'ctx';
  /** The line number on this side. */
  no: number | null;
  text: string;
};

export type DiffRow =
  /** A hunk header or a file header line: it spans both sides. */
  | { type: 'full'; line: ParsedDiffLine }
  /** The old line on the left and the new one on the right; either side can be empty. */
  | { type: 'pair'; left: DiffCell | null; right: DiffCell | null };

/** The text of a hunk line with the `+`, `-` or space the patch put in front of it. */
const unmarked = (text: string): string => text.slice(1);

/**
 * Lay a file's lines out as rows of two sides. An unchanged line is the same on both. A run of
 * removed lines followed by a run of added ones is read as an edit and zipped one to one, so the
 * old and new versions of a line sit across from each other; whichever run is longer leaves the
 * other side empty for the rest. A run of added lines with nothing removed before it, or removed
 * ones with nothing added after, has an empty side throughout. Hunk and file header lines span
 * both sides. Every line appears exactly once.
 */
export function pairSideBySide(lines: readonly ParsedDiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let removed: DiffCell[] = [];
  let added: DiffCell[] = [];

  const flush = () => {
    const count = Math.max(removed.length, added.length);
    for (let i = 0; i < count; i++) {
      rows.push({ left: removed[i] ?? null, right: added[i] ?? null, type: 'pair' });
    }
    removed = [];
    added = [];
  };

  for (const line of lines) {
    if (line.kind === 'del') {
      // A removed line after added ones starts the next edit.
      if (added.length > 0) {
        flush();
      }
      removed.push({ kind: 'del', no: line.oldNo, text: unmarked(line.text) });
    } else if (line.kind === 'add') {
      added.push({ kind: 'add', no: line.newNo, text: unmarked(line.text) });
    } else if (line.kind === 'ctx') {
      flush();
      rows.push({
        left: { kind: 'ctx', no: line.oldNo, text: unmarked(line.text) },
        right: { kind: 'ctx', no: line.newNo, text: unmarked(line.text) },
        type: 'pair',
      });
    } else {
      flush();
      rows.push({ line, type: 'full' });
    }
  }
  flush();
  return rows;
}
