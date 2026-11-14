import type { ParsedDiffLine } from '@/components/approvals/diffParse';

/** The indexes, in each file's lines, of the removed and added lines that are part of a move. */
export type MovedLines = ReadonlyMap<string, ReadonlySet<number>>;

/** A block is moved only when this many consecutive lines match: fewer is a coincidence. */
export const MOVED_MIN_RUN = 3;
/** A line this short (a closing brace, `});`) says nothing about whether code was moved. */
const SUBSTANTIVE_CHARS = 4;
/** Of the lines in a matched block, how many must carry something. */
const MIN_SUBSTANTIVE = 2;
/**
 * A fuzzy match needs this share of a block's lines identical (after trimming): the rest may be
 * edited, but not rewritten.
 */
const FUZZY_IDENTICAL_SHARE = 2 / 3;
/**
 * An edited line still counts as the same line at or above this bigram similarity (0 to 1). Short
 * lines score low for a small edit (`return sum;` to `return sum + 1;` is 0.75), and the identical
 * lines required beside it already anchor the match, so the bar is not set higher.
 */
const FUZZY_LINE_SIMILARITY = 0.7;
/**
 * Lines longer than this are not compared by similarity at all, so one huge line stays cheap: a
 * cap that looked at only the start would call two lines that differ later the same.
 */
const SIMILARITY_MAX_CHARS = 200;
/** A line must be at least this long to be a bucket key: shorter lines are everywhere. */
const BUCKET_KEY_CHARS = 12;
/** A key shared by more windows than this on either side is boilerplate and is not a bucket. */
export const FUZZY_BUCKET_MAX = 8;
/** At most this many removed/added block pairs are compared in one pull request, however large. */
export const FUZZY_MAX_COMPARISONS = 20_000;

type Entry = { hunk: string; id: string; index: number; path: string; trimmed: string };
type Block = Entry[];

/** Each run of consecutive lines of one kind, without its blank lines. */
function runsOf(path: string, lines: readonly ParsedDiffLine[], kind: 'add' | 'del'): Entry[][] {
  const runs: Entry[][] = [];
  let current: Entry[] | null = null;
  let hunks = 0;
  lines.forEach((line, index) => {
    if (line.kind === 'hunk') {
      hunks++;
    }
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
      current.push({ hunk: `${path}\0${hunks}`, id: `${path}\0${index}`, index, path, trimmed });
    }
  });
  return runs;
}

/** Every substantive window of `MOVED_MIN_RUN` consecutive entries of a run. */
function windows(runs: readonly Entry[][]): Block[] {
  const out: Block[] = [];
  for (const run of runs) {
    for (let start = 0; start + MOVED_MIN_RUN <= run.length; start++) {
      const block = run.slice(start, start + MOVED_MIN_RUN);
      if (block.filter((e) => e.trimmed.length >= SUBSTANTIVE_CHARS).length >= MIN_SUBSTANTIVE) {
        out.push(block);
      }
    }
  }
  return out;
}

const exactKey = (block: Block) => block.map((e) => e.trimmed).join('\n');

/** Whether two windows are in the same hunk of the same file. */
const sameHunk = (a: Block, b: Block) => a[0]?.hunk === b[0]?.hunk;

function bigrams(s: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i + 2 <= s.length; i++) {
    const g = s.slice(i, i + 2);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return counts;
}

/** Dice coefficient over character bigrams: 1 for equal text, 0 for nothing in common. */
function similarity(a: string, b: string): number {
  if (a.length > SIMILARITY_MAX_CHARS || b.length > SIMILARITY_MAX_CHARS) {
    return a === b ? 1 : 0;
  }
  const x = bigrams(a);
  const y = bigrams(b);
  let total = 0;
  let common = 0;
  for (const n of x.values()) {
    total += n;
  }
  for (const [g, n] of y) {
    total += n;
    common += Math.min(n, x.get(g) ?? 0);
  }
  return total === 0 ? 0 : (2 * common) / total;
}

/**
 * How alike two blocks are, line against line in order, or null when they are not the same block
 * edited a little: enough lines identical, and every other line a close edit of its partner.
 */
function fuzzyScore(a: Block, b: Block): number | null {
  let identical = 0;
  let score = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]?.trimmed ?? '';
    const y = b[i]?.trimmed ?? '';
    if (x === y) {
      identical++;
      score += 1;
      continue;
    }
    const ratio = similarity(x, y);
    if (ratio < FUZZY_LINE_SIMILARITY) {
      return null;
    }
    score += ratio;
  }
  return identical >= Math.ceil(a.length * FUZZY_IDENTICAL_SHARE) ? score : null;
}

/** Window indexes by each long line the window holds. */
function bucketsOf(blocks: readonly Block[]): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  blocks.forEach((block, i) => {
    for (const key of new Set(block.map((e) => e.trimmed))) {
      if (key.length < BUCKET_KEY_CHARS) {
        continue;
      }
      const list = buckets.get(key) ?? [];
      list.push(i);
      buckets.set(key, list);
    }
  });
  return buckets;
}

export type MovedBlocksResult = { comparisons: number; moved: MovedLines };

/**
 * {@link findMovedBlocks} plus how many removed/added block pairs the fuzzy pass compared, which
 * never exceeds {@link FUZZY_MAX_COMPARISONS}.
 */
export function findMovedBlocksDetailed(
  files: readonly { lines: readonly ParsedDiffLine[]; path: string }[]
): MovedBlocksResult {
  const removed: Block[] = [];
  const added: Block[] = [];
  for (const file of files) {
    removed.push(...windows(runsOf(file.path, file.lines, 'del')));
    added.push(...windows(runsOf(file.path, file.lines, 'add')));
  }
  const moved = new Map<string, Set<number>>();
  const marked = new Set<string>();
  const markEntry = (entry: Entry) => {
    const set = moved.get(entry.path) ?? new Set<number>();
    set.add(entry.index);
    moved.set(entry.path, set);
    marked.add(entry.id);
  };
  const mark = (block: Block) => block.forEach(markEntry);

  // Exact matches first: the same text, ignoring indentation and blank lines.
  const removedKeyed = removed.map((block) => ({ block, key: exactKey(block) }));
  const addedKeyed = added.map((block) => ({ block, key: exactKey(block) }));
  const addedKeys = new Set(addedKeyed.map((w) => w.key));
  const removedKeys = new Set(removedKeyed.map((w) => w.key));
  for (const { block, key } of removedKeyed) {
    if (addedKeys.has(key)) {
      mark(block);
    }
  }
  for (const { block, key } of addedKeyed) {
    if (removedKeys.has(key)) {
      mark(block);
    }
  }

  // Fuzzy matches among the windows no exact match touched, found through shared long lines so
  // that most pairs are never compared.
  const free = (block: Block) => block.every((e) => !marked.has(e.id));
  const removedFree = removed.filter(free);
  const addedFree = added.filter(free);
  const addedBuckets = bucketsOf(addedFree);
  const removedBuckets = bucketsOf(removedFree);
  // Which entry each fuzzy-matched entry is paired with, so overlapping windows of one moved
  // block agree and no line is claimed by two different matches.
  const partner = new Map<string, string>();
  const consistent = (a: Block, b: Block) =>
    a.every((e, i) => {
      const other = b[i];
      if (!other) {
        return false;
      }
      const p = partner.get(e.id);
      const q = partner.get(other.id);
      return (p === undefined || p === other.id) && (q === undefined || q === e.id);
    });

  /** The added windows that share a long line with a removed one, and so are worth comparing. */
  const candidatesOf = (block: Block) => {
    const candidates = new Set<number>();
    for (const key of new Set(block.map((e) => e.trimmed))) {
      const mine = removedBuckets.get(key);
      const theirs = addedBuckets.get(key);
      if (!mine || !theirs) {
        continue;
      }
      if (mine.length > FUZZY_BUCKET_MAX || theirs.length > FUZZY_BUCKET_MAX) {
        continue;
      }
      for (const a of theirs) {
        candidates.add(a);
      }
    }
    return candidates;
  };

  // A removed and an added window of one hunk that match with edits are an edit in place, as when
  // code is re-indented around a changed line. Neither is ever paired with a block elsewhere, or
  // the edit would read as code that moved while its own other half stayed plain.
  const editedInPlace = new Set<Block>();
  for (const block of removedFree) {
    for (const a of candidatesOf(block)) {
      const other = addedFree[a];
      if (other && sameHunk(block, other) && fuzzyScore(block, other) !== null) {
        editedInPlace.add(block);
        editedInPlace.add(other);
      }
    }
  }

  const matches: { added: Block; removed: Block }[] = [];
  let comparisons = 0;
  let capped = false;
  for (const block of removedFree) {
    if (editedInPlace.has(block)) {
      continue;
    }
    let best: { block: Block; score: number } | null = null;
    for (const a of candidatesOf(block)) {
      if (comparisons >= FUZZY_MAX_COMPARISONS) {
        capped = true;
        break;
      }
      const other = addedFree[a] ?? [];
      if (editedInPlace.has(other)) {
        continue;
      }
      comparisons++;
      const score = fuzzyScore(block, other);
      if (score !== null && consistent(block, other) && (best === null || score > best.score)) {
        best = { block: other, score };
      }
    }
    if (best) {
      block.forEach((e, i) => {
        const other = best.block[i];
        if (other) {
          partner.set(e.id, other.id);
          partner.set(other.id, e.id);
        }
      });
      matches.push({ added: best.block, removed: block });
    }
    if (capped) {
      break;
    }
  }

  // The overlapping windows of one block pair are one match. Only its identical lines can be
  // marked (an edited line is still a change), and only when those alone are a run: two identical
  // boilerplate lines around an edit are a coincidence, as they are anywhere else.
  const parent = new Map<string, string>();
  const root = (id: string): string => {
    let at = id;
    for (let next = parent.get(at); next !== undefined && next !== at; next = parent.get(at)) {
      at = next;
    }
    parent.set(id, at);
    return at;
  };
  const join = (x: string, y: string) => parent.set(root(x), root(y));
  for (const { added: b, removed: a } of matches) {
    a.forEach((e, i) => {
      const other = b[i];
      if (other) {
        join(e.id, other.id);
      }
      const next = a[i + 1];
      if (next) {
        join(e.id, next.id);
      }
    });
  }
  const identical = new Map<string, Map<string, [Entry, Entry]>>();
  for (const { added: b, removed: a } of matches) {
    a.forEach((e, i) => {
      const other = b[i];
      if (other && other.trimmed === e.trimmed) {
        const group = identical.get(root(e.id)) ?? new Map<string, [Entry, Entry]>();
        group.set(e.id, [e, other]);
        identical.set(root(e.id), group);
      }
    });
  }
  for (const group of identical.values()) {
    const pairs = [...group.values()];
    const substantive = pairs.filter(([e]) => e.trimmed.length >= SUBSTANTIVE_CHARS).length;
    if (pairs.length >= MOVED_MIN_RUN && substantive >= MIN_SUBSTANTIVE) {
      for (const [e, other] of pairs) {
        markEntry(e);
        markEntry(other);
      }
    }
  }
  return { comparisons, moved };
}

/**
 * The removed lines that reappear as added lines somewhere else in the change, and those added
 * lines: code that was moved. A block is {@link MOVED_MIN_RUN} consecutive lines, ignoring blank
 * lines, with at least two that carry content. It is moved when it matches a block of added lines
 * (or removed lines) anywhere in the pull request, the same file or another, either exactly
 * (ignoring indentation) or with edits. A removed and an added block of one hunk that match with
 * edits are an edit in place (re-indenting code leaves exactly such a pair around a real change),
 * so neither is ever matched with edits to a block elsewhere. Only the identical lines of a fuzzy
 * match are marked, and only when, across the overlapping windows of the matched block pair, they
 * are themselves at least {@link MOVED_MIN_RUN} lines with two that carry content. A fuzzy match
 * needs at least two thirds of its lines identical after trimming
 * and every other line at least 70% similar to its partner in the same position. Blocks never
 * match across a reordering, an inserted or deleted line, or a line rewritten past that
 * similarity. Fuzzy matching finds candidates through shared lines of 12 or more characters, so a
 * block whose identical lines are all shorter, or that share only boilerplate repeated more than
 * {@link FUZZY_BUCKET_MAX} times, is not found; at most {@link FUZZY_MAX_COMPARISONS} block pairs
 * are compared per pull request, after which the rest are left as ordinary changes. Lines
 * matched exactly are not re-examined, so an edited line next to an exactly moved block is not
 * marked. A line longer than {@link SIMILARITY_MAX_CHARS} matches only an identical line.
 * Near-linear in the lines.
 */
export function findMovedBlocks(
  files: readonly { lines: readonly ParsedDiffLine[]; path: string }[]
): MovedLines {
  return findMovedBlocksDetailed(files).moved;
}
