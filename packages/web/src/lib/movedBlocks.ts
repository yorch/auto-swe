import type { ParsedDiffLine } from '@/components/approvals/diffParse';

/** The indexes, in each file's lines, of the removed and added lines that are part of a move. */
export type MovedLines = ReadonlyMap<string, ReadonlySet<number>>;

/** A block is moved only when this many consecutive lines match: fewer is a coincidence. */
export const MOVED_MIN_RUN = 3;
/** A line this short (a closing brace, `});`) says nothing about whether code was moved. */
const SUBSTANTIVE_CHARS = 4;
/** Of the lines in a matched block, how many must carry something. */
const MIN_SUBSTANTIVE = 2;

type Entry = { index: number; path: string; trimmed: string };

/** Each run of consecutive lines of one kind, without its blank lines. */
function runsOf(path: string, lines: readonly ParsedDiffLine[], kind: 'add' | 'del'): Entry[][] {
  const runs: Entry[][] = [];
  let current: Entry[] | null = null;
  lines.forEach((line, index) => {
    if (line.kind !== kind) {
      current = null;
      return;
    }
    if (current === null) {
      current = [];
      runs.push(current);
    }
    // The patch's leading marker is not part of the code.
    const trimmed = line.text.slice(1).trim();
    if (trimmed !== '') {
      current.push({ index, path, trimmed });
    }
  });
  return runs;
}

/** Every window of `MOVED_MIN_RUN` consecutive entries of a run, keyed by what they say. */
function windows(runs: readonly Entry[][], into: Map<string, Entry[][]>): void {
  for (const run of runs) {
    for (let start = 0; start + MOVED_MIN_RUN <= run.length; start++) {
      const block = run.slice(start, start + MOVED_MIN_RUN);
      if (block.filter((e) => e.trimmed.length >= SUBSTANTIVE_CHARS).length < MIN_SUBSTANTIVE) {
        continue;
      }
      const key = block.map((e) => e.trimmed).join('\n');
      into.set(key, [...(into.get(key) ?? []), block]);
    }
  }
}

/**
 * The removed lines that reappear as added lines somewhere else in the change, and those added
 * lines: code that was moved, not rewritten. A block is moved when at least {@link MOVED_MIN_RUN}
 * consecutive removed lines match, ignoring indentation and blank lines, a run of added lines
 * anywhere in the pull request (the same file or another), and at least two of them have content.
 * Exact matches only: a moved block that was also edited is not found. Linear in the lines.
 */
export function findMovedBlocks(
  files: readonly { lines: readonly ParsedDiffLine[]; path: string }[]
): MovedLines {
  const removed = new Map<string, Entry[][]>();
  const added = new Map<string, Entry[][]>();
  for (const file of files) {
    windows(runsOf(file.path, file.lines, 'del'), removed);
    windows(runsOf(file.path, file.lines, 'add'), added);
  }
  const moved = new Map<string, Set<number>>();
  const mark = (blocks: readonly Entry[][]) => {
    for (const block of blocks) {
      for (const entry of block) {
        const set = moved.get(entry.path) ?? new Set<number>();
        set.add(entry.index);
        moved.set(entry.path, set);
      }
    }
  };
  for (const [key, blocks] of removed) {
    const other = added.get(key);
    if (other) {
      mark(blocks);
      mark(other);
    }
  }
  return moved;
}
