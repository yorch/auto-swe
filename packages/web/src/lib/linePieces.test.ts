import { describe, expect, it } from 'vitest';
import type { Segment } from './intraLineDiff';
import { composePieces, type SyntaxToken } from './linePieces';

const token = (text: string, light: string | null = '#111111'): SyntaxToken => ({
  bold: false,
  dark: light === null ? null : '#eeeeee',
  italic: false,
  light,
  text,
});
const seg = (text: string, changed: boolean): Segment => ({ changed, text });
const text = (pieces: ReturnType<typeof composePieces>) => pieces.map((p) => p.text).join('');

describe('composePieces', () => {
  it('is one plain piece when there is nothing to split on', () => {
    expect(composePieces('const a = 1;', undefined, undefined)).toEqual([
      { changed: false, text: 'const a = 1;', token: null },
    ]);
  });

  it('follows the syntax tokens when there are no changed words', () => {
    const tokens = [token('const'), token(' '), token('a')];
    const pieces = composePieces('const a', tokens, undefined);
    expect(pieces.map((p) => [p.text, p.token?.light, p.changed])).toEqual([
      ['const', '#111111', false],
      [' ', '#111111', false],
      ['a', '#111111', false],
    ]);
  });

  it('follows the changed words when there are no syntax tokens', () => {
    const pieces = composePieces('x = old', undefined, [seg('x = ', false), seg('old', true)]);
    expect(pieces.map((p) => [p.text, p.token, p.changed])).toEqual([
      ['x = ', null, false],
      ['old', null, true],
    ]);
  });

  it('splits at the boundaries of both, so every piece has one colour and one state', () => {
    // Tokens: "let" " " "count", segments: "let co" plain, "unt" changed. They cut "count" apart.
    const pieces = composePieces(
      'let count',
      [token('let', '#aa0000'), token(' ', null), token('count', '#00aa00')],
      [seg('let co', false), seg('unt', true)]
    );
    expect(pieces.map((p) => [p.text, p.token?.light ?? null, p.changed])).toEqual([
      ['let', '#aa0000', false],
      [' ', null, false],
      ['co', '#00aa00', false],
      ['unt', '#00aa00', true],
    ]);
  });

  it('always joins back into the line', () => {
    const line = 'if (a.b(c)) { return 1; }';
    const tokens = [token('if'), token(' (a.b(c)) '), token('{ return 1; }')];
    const segments = [seg('if (a.b(', false), seg('c', true), seg(')) { return 1; }', false)];
    expect(text(composePieces(line, tokens, segments))).toBe(line);
    expect(text(composePieces(line, tokens, undefined))).toBe(line);
    expect(text(composePieces(line, undefined, segments))).toBe(line);
  });

  it('ignores syntax tokens that do not add up to the line, so the line stays what the patch says', () => {
    const pieces = composePieces('real text', [token('other text')], undefined);
    expect(pieces).toEqual([{ changed: false, text: 'real text', token: null }]);
  });

  it('ignores segments that do not add up to the line, and keeps the tokens', () => {
    const pieces = composePieces('abc', [token('abc')], [seg('xyz', true)]);
    expect(pieces).toEqual([{ changed: false, text: 'abc', token: token('abc') }]);
  });

  it('answers one empty piece for an empty line', () => {
    expect(composePieces('', [], [])).toEqual([{ changed: false, text: '', token: null }]);
  });

  it('keeps a token of an astral character whole', () => {
    const pieces = composePieces('a😀b', [token('a'), token('😀'), token('b')], undefined);
    expect(pieces.map((p) => p.text)).toEqual(['a', '😀', 'b']);
  });
});
