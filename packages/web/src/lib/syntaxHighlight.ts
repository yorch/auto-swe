import type { HighlighterCore, LanguageInput, ThemedToken } from 'shiki/types';
import type { SyntaxToken } from './linePieces';

/**
 * Colouring for code in the review page, with shiki. The highlighter, its engine, its two themes
 * and each grammar are loaded the first time something needs them, and each grammar only when a
 * file of its language is opened, so a page of unrelated files pays for none of it. Colours come
 * back as plain data and are drawn by React as text: nothing here produces markup.
 */

/** Every language a file can be coloured as, each with the loader of its grammar. */
const LANGUAGES = {
  bash: () => import('shiki/langs/bash.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  make: () => import('shiki/langs/make.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  prisma: () => import('shiki/langs/prisma.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
} satisfies Record<string, () => Promise<{ default: LanguageInput }>>;

export type SyntaxLanguage = keyof typeof LANGUAGES;

const BY_EXTENSION: Record<string, SyntaxLanguage> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  conf: 'bash',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  cts: 'typescript',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  htm: 'html',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  jsx: 'jsx',
  kt: 'kotlin',
  kts: 'kotlin',
  markdown: 'markdown',
  md: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  php: 'php',
  prisma: 'prisma',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
};

const BY_NAME: Record<string, SyntaxLanguage> = {
  Dockerfile: 'docker',
  GNUmakefile: 'make',
  Makefile: 'make',
  makefile: 'make',
};

/** Past either bound a file is left uncoloured: tokenising is work the reviewer waits behind. */
export const MAX_HIGHLIGHT_CHARS = 150_000;
const TOKENIZE_TIME_LIMIT_MS = 500;

/** The language a file is coloured as, from its name; null for one this does not know. */
export function languageForPath(path: string): SyntaxLanguage | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const byName = BY_NAME[name];
  if (byName) {
    return byName;
  }
  const dot = name.lastIndexOf('.');
  // A dotfile (`.env`) has no extension, and a trailing dot names nothing.
  if (dot <= 0 || dot === name.length - 1) {
    return null;
  }
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

const LIGHT_THEME = 'github-light';
const DARK_THEME = 'github-dark';

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLanguages = new Map<SyntaxLanguage, Promise<void>>();

/** The one highlighter, made on first use. A failed load is forgotten so a later call tries again. */
function highlighter(): Promise<HighlighterCore> {
  if (highlighterPromise === null) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] =
        await Promise.all([
          import('shiki/core'),
          import('shiki/engine/javascript'),
          import('shiki/themes/github-light.mjs'),
          import('shiki/themes/github-dark.mjs'),
        ]);
      return createHighlighterCore({
        engine: createJavaScriptRegexEngine(),
        langs: [],
        themes: [light.default, dark.default],
      });
    })().catch((error: unknown) => {
      highlighterPromise = null;
      throw error;
    });
  }
  return highlighterPromise;
}

async function withLanguage(language: SyntaxLanguage): Promise<HighlighterCore> {
  const core = await highlighter();
  let loaded = loadedLanguages.get(language);
  if (loaded === undefined) {
    loaded = LANGUAGES[language]().then((module) => core.loadLanguage(module.default));
    loadedLanguages.set(language, loaded);
    loaded.catch(() => loadedLanguages.delete(language));
  }
  await loaded;
  return core;
}

/** A colour from a theme, kept only if it is a hex colour: it ends up in an inline style. */
export function colorOrNull(value: string | undefined): string | null {
  return value !== undefined && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : null;
}

function toSyntaxToken(token: ThemedToken): SyntaxToken {
  const style = token.htmlStyle ?? {};
  const fontStyle = `${style['--shiki-light-font-style'] ?? ''} ${style['--shiki-dark-font-style'] ?? ''}`;
  return {
    bold: /bold/.test(fontStyle),
    dark: colorOrNull(style['--shiki-dark']),
    italic: /italic/.test(fontStyle),
    light: colorOrNull(style['--shiki-light']),
    text: token.content,
  };
}

/**
 * Colour some lines of code, as one block so the grammar's state carries from line to line. One
 * list of tokens per line, in order, or null when the code is too large or the highlighter cannot
 * be loaded: the caller then draws it plain.
 */
export async function highlightLines(
  language: SyntaxLanguage,
  lines: readonly string[]
): Promise<SyntaxToken[][] | null> {
  const code = lines.join('\n');
  if (code.length > MAX_HIGHLIGHT_CHARS) {
    return null;
  }
  try {
    const core = await withLanguage(language);
    const { tokens } = core.codeToTokens(code, {
      defaultColor: false,
      lang: language,
      themes: { dark: DARK_THEME, light: LIGHT_THEME },
      tokenizeTimeLimit: TOKENIZE_TIME_LIMIT_MS,
    });
    return tokens.map((line) => line.map(toSyntaxToken));
  } catch {
    return null;
  }
}
