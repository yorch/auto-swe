import { describe, expect, it, vi } from 'vitest';

vi.mock('shiki/langs/go.mjs', () => {
  throw new Error('the grammar could not be loaded');
});

import {
  colorOrNull,
  highlightLines,
  languageForPath,
  MAX_HIGHLIGHT_CHARS,
} from './syntaxHighlight';

const HEX = /^#[0-9a-fA-F]{3,8}$/;

describe('languageForPath', () => {
  it.each([
    ['src/app.ts', 'typescript'],
    ['src/App.TSX', 'tsx'],
    ['a/b/c/server.mjs', 'javascript'],
    ['config.yml', 'yaml'],
    ['config.yaml', 'yaml'],
    ['README.md', 'markdown'],
    ['schema.prisma', 'prisma'],
    ['deploy.sh', 'bash'],
    ['main.go', 'go'],
    ['lib.rs', 'rust'],
    ['pkg/types.d.ts', 'typescript'],
  ])('reads %s as %s', (path, language) => {
    expect(languageForPath(path)).toBe(language);
  });

  it.each([
    ['Dockerfile', 'docker'],
    ['services/api/Dockerfile', 'docker'],
    ['Makefile', 'make'],
  ])('reads the file name %s as %s', (path, language) => {
    expect(languageForPath(path)).toBe(language);
  });

  it.each(['.env', '.gitignore', 'LICENSE', 'trailing.', 'archive.tar.gz', 'photo.png', ''])(
    'knows no language for %j',
    (path) => {
      expect(languageForPath(path)).toBeNull();
    }
  );

  it('reads the extension of the last path segment only', () => {
    expect(languageForPath('some.dir/file')).toBeNull();
    expect(languageForPath('some.ts/file')).toBeNull();
  });
});

describe('colorOrNull', () => {
  it.each(['#fff', '#ffffff', '#FFFFFF80', '#6a737d'])('keeps the hex colour %s', (value) => {
    expect(colorOrNull(value)).toBe(value);
  });

  it.each([
    undefined,
    '',
    'red',
    'rgb(0,0,0)',
    '#ggg',
    '#12',
    '#123456789',
    'url(javascript:alert(1))',
    '#fff; background: url(x)',
    'var(--x)',
  ])('drops %j, since it ends up in an inline style', (value) => {
    expect(colorOrNull(value)).toBeNull();
  });
});

describe('highlightLines', () => {
  it('gives one list of tokens for each line, whose text joins back into the line', async () => {
    const lines = [
      'const total = price * 2;',
      'export function f(a: number) {',
      '  return a;',
      '}',
    ];
    const tokens = await highlightLines('typescript', lines);
    expect(tokens).not.toBeNull();
    expect(tokens).toHaveLength(lines.length);
    lines.forEach((line, i) => {
      expect(tokens?.[i]?.map((t) => t.text).join('')).toBe(line);
    });
  }, 20_000);

  it('gives each coloured token a colour for the light theme and one for the dark', async () => {
    const tokens = await highlightLines('typescript', ['const total = 42;']);
    const coloured = (tokens?.[0] ?? []).filter((t) => t.light !== null);
    expect(coloured.length).toBeGreaterThan(0);
    for (const token of coloured) {
      expect(token.light).toMatch(HEX);
      expect(token.dark).toMatch(HEX);
    }
    // The themes differ, so a coloured token is not the same colour in both.
    expect(coloured.some((t) => t.light !== t.dark)).toBe(true);
  }, 20_000);

  it('colours a keyword differently from a plain name', async () => {
    const [line] = (await highlightLines('typescript', ['const total = other;'])) ?? [];
    const keyword = line?.find((t) => t.text === 'const');
    const name = line?.find((t) => t.text === 'other');
    expect(keyword?.light).toBeTruthy();
    expect(keyword?.light).not.toBe(name?.light ?? null);
  }, 20_000);

  it('carries the grammar across lines, so a comment stays a comment', async () => {
    const tokens = await highlightLines('typescript', [
      '/* a comment',
      'that goes on',
      'and ends */',
      'const x = 1;',
    ]);
    const color = (line: number) => tokens?.[line]?.[0]?.light;
    expect(color(0)).toBeTruthy();
    expect(color(1)).toBe(color(0));
    expect(color(2)).toBe(color(0));
    expect(tokens?.[3]?.find((t) => t.text === 'const')?.light).not.toBe(color(0));
  }, 20_000);

  it('keeps a line that is empty', async () => {
    const tokens = await highlightLines('typescript', ['const a = 1;', '', 'const b = 2;']);
    expect(tokens).toHaveLength(3);
    expect(tokens?.[1]?.map((t) => t.text).join('')).toBe('');
  }, 20_000);

  it('keeps tabs and trailing spaces exactly', async () => {
    const lines = ['\tconst a = 1;  '];
    const tokens = await highlightLines('typescript', lines);
    expect(tokens?.[0]?.map((t) => t.text).join('')).toBe(lines[0]);
  }, 20_000);

  it('colours other languages too', async () => {
    const tokens = await highlightLines('python', ['def total(a):', '    return a + 1']);
    expect(tokens).toHaveLength(2);
    expect(tokens?.[0]?.some((t) => t.light !== null)).toBe(true);
  }, 20_000);

  it('makes no markup: tokens are text and colours only', async () => {
    const tokens = await highlightLines('typescript', [
      'const s = "<img src=x onerror=alert(1)>";',
    ]);
    const text = (tokens?.[0] ?? []).map((t) => t.text).join('');
    expect(text).toBe('const s = "<img src=x onerror=alert(1)>";');
    for (const token of tokens?.[0] ?? []) {
      expect(Object.keys(token).sort()).toEqual(['bold', 'dark', 'italic', 'light', 'text']);
    }
  }, 20_000);

  it('leaves code past the size limit uncoloured', async () => {
    const big = 'x'.repeat(MAX_HIGHLIGHT_CHARS + 1);
    expect(await highlightLines('typescript', [big])).toBeNull();
  });

  it('answers null, and does not throw, when a grammar cannot be loaded', async () => {
    await expect(highlightLines('go', ['package main'])).resolves.toBeNull();
  });
});
