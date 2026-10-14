import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractToc } from '@auto-swe/shared/lib/docToc';
import { describe, expect, it } from 'vitest';
import { HELP_LINKS } from './helpLinks';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.resolve(HERE, '../../../../docs');
const SRC_DIR = path.resolve(HERE, '..');

const ENTRIES = Object.entries(HELP_LINKS) as [string, { slug: string; anchor?: string }][];

describe('HELP_LINKS', () => {
  it.each(ENTRIES)('%s points at a doc and heading that exist', (_key, link) => {
    const file = path.join(DOCS_DIR, `${link.slug}.md`);
    expect(existsSync(file), `${link.slug}.md`).toBe(true);
    if (link.anchor) {
      const ids = extractToc(readFileSync(file, 'utf8')).map((entry) => entry.id);
      expect(ids, `#${link.anchor} in ${link.slug}.md`).toContain(link.anchor);
    }
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }
    const isSource = name.endsWith('.tsx') || name.endsWith('.ts');
    return isSource && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

/**
 * The text from `open` (the index of an opening bracket) to its matching close, skipping string
 * literals. A prop holding an arrow function (`=>`) or a nested object therefore cannot end the
 * scan early the way a `[^>]*` pattern would.
 */
function balanced(text: string, open: number, pair: [string, string]): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === pair[0]) {
      depth += 1;
    } else if (ch === pair[1]) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(open, i + 1);
      }
    }
  }
  return text.slice(open);
}

/** Character offsets in `text` where a doc link names its target by hand instead of HELP_LINKS. */
function literalDocLinks(text: string): number[] {
  const found: number[] = [];
  // <DocLink ... slug="x" ...>: walk the tag to its end, then look for a literal slug.
  for (const m of text.matchAll(/<DocLink\b/g)) {
    let end = m.index + m[0].length;
    while (end < text.length && text[end] !== '>') {
      end += text[end] === '{' ? balanced(text, end, ['{', '}']).length : 1;
    }
    // Spreads (`{...HELP_LINKS.x}`) and other brace props are not literals; strip them first.
    let tag = text.slice(m.index, end);
    for (const brace of tag.matchAll(/\{/g)) {
      const inner = balanced(tag, brace.index, ['{', '}']);
      if (/^\{\s*(?:\.\.\.|[^'"`])/.test(inner)) {
        tag = tag.replace(inner, '{}');
      }
    }
    if (/\bslug=(?:"|'|\{\s*['"`])/.test(tag)) {
      found.push(m.index);
    }
  }
  // learnMore={{ ... slug: 'x' ... }}
  for (const m of text.matchAll(/learnMore=\{/g)) {
    const prop = balanced(text, m.index + m[0].length - 1, ['{', '}']);
    if (/\bslug:\s*['"`]/.test(prop)) {
      found.push(m.index);
    }
  }
  // A path written by hand: href="/docs/x", href={`/docs/x`}, router.push('/docs/x').
  for (const m of text.matchAll(/['"`]\/docs\//g)) {
    found.push(m.index);
  }
  return found;
}

// The link components themselves, and the docs reader, take a slug as data.
const ALLOWED = new Set([
  'components/ui/DocLink.tsx',
  'components/ui/PageHeader.tsx',
  'components/ui/HelpTip.tsx',
]);

function isDocsSurface(rel: string): boolean {
  return ALLOWED.has(rel) || rel.startsWith('app/docs/') || rel.startsWith('components/docs/');
}

describe('inline doc links', () => {
  it('the scan sees a literal slug after an arrow-function prop', () => {
    expect(literalDocLinks('<DocLink onClick={() => go()} slug="agents" />')).toHaveLength(1);
    expect(literalDocLinks('<DocLink onClick={() => go()} {...HELP_LINKS.agents} />')).toEqual([]);
    expect(literalDocLinks('<DocLink label="x" {...HELP_LINKS.agents} />')).toEqual([]);
  });

  it('the scan sees a literal learnMore slug and a hand-written /docs/ path', () => {
    expect(literalDocLinks("<PageHeader learnMore={{ slug: 'evals' }} />")).toHaveLength(1);
    expect(
      literalDocLinks('<PageHeader learnMore={{ ...HELP_LINKS.evals, label: "x" }} />')
    ).toEqual([]);
    expect(literalDocLinks('<Link href="/docs/agents">x</Link>')).toHaveLength(1);
  });

  it('reference HELP_LINKS instead of a literal slug or a raw /docs/ path', () => {
    const offenders: string[] = [];
    for (const dir of ['app', 'components']) {
      for (const file of sourceFiles(path.join(SRC_DIR, dir))) {
        const rel = path.relative(SRC_DIR, file).split(path.sep).join('/');
        if (isDocsSurface(rel)) {
          continue;
        }
        const text = readFileSync(file, 'utf8');
        for (const index of literalDocLinks(text)) {
          offenders.push(`${rel}:${text.slice(0, index).split('\n').length}`);
        }
      }
    }
    expect(offenders, 'use HELP_LINKS from @/lib/helpLinks').toEqual([]);
  });
});
