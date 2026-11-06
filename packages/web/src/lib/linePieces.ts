import type { Segment } from './intraLineDiff';

/**
 * A stretch of code and the colours the grammar gives it, one for each of the dashboard's themes.
 * The colours are checked when the token is made (see `colorOrNull`): only a hex colour is kept.
 */
export type SyntaxToken = {
  bold: boolean;
  dark: string | null;
  italic: boolean;
  light: string | null;
  text: string;
};

/** A stretch of a line with one colouring and one changed-or-not state. */
export type Piece = { changed: boolean; text: string; token: SyntaxToken | null };

/** A source whose text does not join back into the line is ignored: the line is what the patch says. */
const covers = (text: string, parts: readonly { text: string }[]): boolean =>
  parts.map((p) => p.text).join('') === text;

/**
 * The pieces of one line: split wherever its syntax tokens or its changed-word segments change, so
 * each piece has one colour and is either changed or not. Either source can be missing, and a source
 * that does not add up to the line's text is left out, so the pieces always join back into `text`.
 */
export function composePieces(
  text: string,
  tokens: readonly SyntaxToken[] | undefined,
  segments: readonly Segment[] | undefined
): Piece[] {
  const useTokens = tokens !== undefined && covers(text, tokens) ? tokens : undefined;
  const useSegments = segments !== undefined && covers(text, segments) ? segments : undefined;
  if (useTokens === undefined && useSegments === undefined) {
    return [{ changed: false, text, token: null }];
  }
  const cuts = new Set<number>([0, text.length]);
  const addCuts = (parts: readonly { text: string }[] | undefined) => {
    let at = 0;
    for (const part of parts ?? []) {
      at += part.text.length;
      cuts.add(at);
    }
  };
  addCuts(useTokens);
  addCuts(useSegments);
  const points = [...cuts].sort((a, b) => a - b);

  const tokenAt = (offset: number): SyntaxToken | null => {
    let at = 0;
    for (const token of useTokens ?? []) {
      if (offset < at + token.text.length) {
        return token;
      }
      at += token.text.length;
    }
    return null;
  };
  const changedAt = (offset: number): boolean => {
    let at = 0;
    for (const segment of useSegments ?? []) {
      if (offset < at + segment.text.length) {
        return segment.changed;
      }
      at += segment.text.length;
    }
    return false;
  };

  const pieces: Piece[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i] as number;
    const end = points[i + 1] as number;
    if (end > start) {
      pieces.push({
        changed: changedAt(start),
        text: text.slice(start, end),
        token: tokenAt(start),
      });
    }
  }
  return pieces.length > 0 ? pieces : [{ changed: false, text, token: null }];
}
