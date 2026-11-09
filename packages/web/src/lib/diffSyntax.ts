import type { ParsedDiffLine } from '@/components/approvals/diffParse';
import type { SyntaxToken } from './linePieces';
import { highlightLines, languageForPath } from './syntaxHighlight';

/** The syntax tokens of a file's lines, by the index of the line in the parsed lines. */
export type LineSyntax = ReadonlyMap<number, readonly SyntaxToken[]>;

type Entry = { index: number; kind: 'add' | 'ctx' | 'del'; text: string };

/**
 * Colour a file's lines. A patch is not code in one piece: it is hunks, and in each hunk the new
 * version of the file (unchanged and added lines) and the old one (unchanged and removed lines) are
 * read by the grammar separately, so a removed line is coloured as the line it was and not as one
 * between its neighbours. An unchanged line takes its colours from the new side.
 *
 * Null when the file's language is not known, or none of it could be coloured. A line whose tokens
 * do not add up to its text is left plain, so what is drawn is always what the patch says.
 */
export async function syntaxForDiff(
  path: string,
  lines: readonly ParsedDiffLine[]
): Promise<LineSyntax | null> {
  const language = languageForPath(path);
  if (language === null) {
    return null;
  }
  const hunks: Entry[][] = [];
  let current: Entry[] | null = null;
  lines.forEach((line, index) => {
    if (line.kind === 'hunk') {
      current = [];
      hunks.push(current);
    } else if (line.kind !== 'meta') {
      // The parser reads a line as code only inside a hunk, so there is always one open here.
      // The patch's leading `+`, `-` or space is not code.
      current?.push({ index, kind: line.kind, text: line.text.slice(1) });
    }
  });

  const result = new Map<number, readonly SyntaxToken[]>();
  // `keep` picks which of a side's lines take its colours; the rest are read only so the grammar
  // is in the right state when it reaches the ones that do.
  const side = async (entries: readonly Entry[], keep: (entry: Entry) => boolean) => {
    if (entries.length === 0) {
      return;
    }
    const tokens = await highlightLines(
      language,
      entries.map((e) => e.text)
    );
    if (tokens === null || tokens.length !== entries.length) {
      return;
    }
    entries.forEach((entry, i) => {
      const lineTokens = tokens[i] ?? [];
      if (keep(entry) && lineTokens.map((t) => t.text).join('') === entry.text) {
        result.set(entry.index, lineTokens);
      }
    });
  };
  await Promise.all(
    hunks.flatMap((hunk) => [
      // The new file: unchanged and added lines, all of which take its colours.
      side(
        hunk.filter((e) => e.kind !== 'del'),
        () => true
      ),
      // The old file: unchanged and removed lines, of which only the removed ones take its colours.
      side(
        hunk.filter((e) => e.kind !== 'add'),
        (e) => e.kind === 'del'
      ),
    ])
  );
  return result.size > 0 ? result : null;
}
