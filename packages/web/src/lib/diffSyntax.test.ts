import { describe, expect, it } from 'vitest';
import { parseFilePatch } from '@/components/approvals/diffParse';
import { syntaxForDiff } from './diffSyntax';

const parse = (...patch: string[]) => parseFilePatch(patch.join('\n')).lines;
const textOf = (tokens: readonly { text: string }[] | undefined) =>
  (tokens ?? []).map((t) => t.text).join('');

describe('syntaxForDiff', () => {
  it('is null for a file whose language is not known', async () => {
    expect(await syntaxForDiff('photo.png', parse('@@ -1 +1 @@', '-a', '+b'))).toBeNull();
    expect(await syntaxForDiff('LICENSE', parse('@@ -1 +1 @@', '-a', '+b'))).toBeNull();
  });

  it('gives tokens for each added, removed and unchanged line, by the index of the line', async () => {
    const lines = parse('@@ -1,2 +1,2 @@', ' const a = 1;', '-const b = 2;', '+const b = 3;');
    const syntax = await syntaxForDiff('a.ts', lines);
    expect(syntax).not.toBeNull();
    // 0 is the hunk header; it has no tokens.
    expect(syntax?.has(0)).toBe(false);
    expect(textOf(syntax?.get(1))).toBe('const a = 1;');
    expect(textOf(syntax?.get(2))).toBe('const b = 2;');
    expect(textOf(syntax?.get(3))).toBe('const b = 3;');
  }, 20_000);

  it('leaves out the patch’s own marker, which is not code', async () => {
    const lines = parse('@@ -1 +1 @@', '-let x = 1;', '+let x = 2;');
    const syntax = await syntaxForDiff('a.ts', lines);
    expect(textOf(syntax?.get(1))).toBe('let x = 1;');
    expect(textOf(syntax?.get(2))).toBe('let x = 2;');
  }, 20_000);

  it('reads the removed lines as the old file, so a comment they open is a comment to them', async () => {
    // In the old file these three lines are one comment; in the new file they are code.
    const lines = parse(
      '@@ -1,3 +1,3 @@',
      '-/* old comment',
      '-still the comment',
      '-end */',
      '+const a = 1;',
      '+const b = 2;',
      '+const c = 3;'
    );
    const syntax = await syntaxForDiff('a.ts', lines);
    const comment = syntax?.get(1)?.[0]?.light;
    expect(comment).toBeTruthy();
    expect(syntax?.get(2)?.[0]?.light).toBe(comment);
    expect(syntax?.get(3)?.[0]?.light).toBe(comment);
    // The added lines are code in the new file: their keyword is not the comment's colour.
    expect(syntax?.get(4)?.find((t) => t.text === 'const')?.light).not.toBe(comment);
  }, 20_000);

  it('does not let a removed line change how the unchanged ones around it are read', async () => {
    const lines = parse(
      '@@ -1,3 +1,2 @@',
      ' const a = 1;',
      '-/* a removed comment opener',
      ' const b = 2;'
    );
    const syntax = await syntaxForDiff('a.ts', lines);
    // In the new file there is no comment, so the unchanged line after it is plain code.
    const keyword = syntax?.get(3)?.find((t) => t.text === 'const')?.light;
    const first = syntax?.get(1)?.find((t) => t.text === 'const')?.light;
    expect(keyword).toBeTruthy();
    expect(keyword).toBe(first);
  }, 20_000);

  it('reads each hunk on its own', async () => {
    const lines = parse(
      '@@ -1,1 +1,1 @@',
      '+/* opens a comment',
      '@@ -40,1 +40,1 @@',
      '+const after = 1;'
    );
    const syntax = await syntaxForDiff('a.ts', lines);
    const comment = syntax?.get(1)?.[0]?.light;
    // The comment opened in the first hunk does not run into the second.
    expect(syntax?.get(3)?.find((t) => t.text === 'const')?.light).not.toBe(comment);
  }, 20_000);

  it('finds no code in lines that come before any hunk header, which the parser reads as headers', async () => {
    expect(await syntaxForDiff('a.ts', parse(' const a = 1;', '+const b = 2;'))).toBeNull();
  });

  it('does not colour the "no newline" marker, which is not code', async () => {
    const lines = parse('@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+b');
    const syntax = await syntaxForDiff('a.ts', lines);
    expect(syntax?.has(2)).toBe(false);
  }, 20_000);

  it('is null for a patch with nothing to colour', async () => {
    expect(await syntaxForDiff('a.ts', [])).toBeNull();
    expect(await syntaxForDiff('a.ts', parse('@@ -1 +1 @@'))).toBeNull();
  });
});
