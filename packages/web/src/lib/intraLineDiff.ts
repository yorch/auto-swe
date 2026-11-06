import { commonSubsequence } from './sequenceDiff';

/** A stretch of a line, and whether it is part of what the edit changed. */
export type Segment = { changed: boolean; text: string };

/** Longer lines are not compared word by word: the result would be noise, and slow to reach. */
export const MAX_INTRA_LINE_CHARS = 500;
/** The most token pairs one comparison builds a table for. */
const MAX_TOKEN_CELLS = 40_000;
/** Below this share of words in common, two lines are a rewrite and nothing is marked. */
const MIN_COMMON_SHARE = 0.4;

// A word, a number, a run of whitespace, or any other single code point: every code point of a line
// falls in exactly one of these, so the tokens of a line always join back into the line.
const TOKEN = /\p{L}[\p{L}\p{N}_]*|\p{N}+|\s+|[^\p{L}\p{N}\s]/gu;

const tokenize = (text: string): string[] => Array.from(text.matchAll(TOKEN), (m) => m[0]);

const isWord = (token: string): boolean => /\S/u.test(token);

/** Merge neighbouring tokens in the same state into one segment. */
function toSegments(tokens: readonly string[], changed: readonly boolean[]): Segment[] {
  const segments: Segment[] = [];
  tokens.forEach((token, i) => {
    const last = segments[segments.length - 1];
    if (last && last.changed === changed[i]) {
      last.text += token;
    } else {
      segments.push({ changed: changed[i] ?? false, text: token });
    }
  });
  return segments;
}

/**
 * Which words of an edited line changed, for a removed line and the added line that replaces it. The
 * two are compared by word, number, space and symbol, and what they share is left plain.
 *
 * Null when marking would not help: a line past {@link MAX_INTRA_LINE_CHARS}, a pair too large to
 * compare, two lines with too little in common (a rewrite, where marking everything marks nothing),
 * or two lines with no difference to show. The caller then draws both lines plain.
 */
export function intraLineDiff(
  removed: string,
  added: string
): { added: Segment[]; removed: Segment[] } | null {
  if (
    removed === added ||
    removed.length > MAX_INTRA_LINE_CHARS ||
    added.length > MAX_INTRA_LINE_CHARS
  ) {
    return null;
  }
  const before = tokenize(removed);
  const after = tokenize(added);
  if (before.length * after.length > MAX_TOKEN_CELLS) {
    return null;
  }
  const matches = commonSubsequence(before, after);
  const beforeKept = new Set(matches.map(([i]) => i));
  const afterKept = new Set(matches.map(([, j]) => j));

  const words = Math.max(before.filter(isWord).length, after.filter(isWord).length);
  const sharedWords = matches.filter(([i]) => isWord(before[i] ?? '')).length;
  if (words === 0 || sharedWords / words < MIN_COMMON_SHARE) {
    return null;
  }
  return {
    added: toSegments(
      after,
      after.map((_, j) => !afterKept.has(j))
    ),
    removed: toSegments(
      before,
      before.map((_, i) => !beforeKept.has(i))
    ),
  };
}
