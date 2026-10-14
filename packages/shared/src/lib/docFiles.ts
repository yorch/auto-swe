/**
 * The served docs as files: which ones exist, what each is called, and their text. The dashboard's
 * `/docs` pages and the in-app assistant's `searchDocs` tool both read the docs through this, so the
 * assistant searches exactly the set a user can open.
 *
 * Only the top level of a docs directory is read. `docs/history/` is frozen by convention —
 * publishing it to product users would advertise superseded behaviour as current — and
 * `docs/redesign/` is image reference material.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSearchIndexAsync, type SearchIndex } from './docSearch.js';

export type DocMeta = {
  slug: string;
  title: string;
  description: string;
};

export type Doc = DocMeta & {
  content: string;
};

export const DOC_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;

/**
 * Titles the doc's own `# heading` gets wrong. Keep this empty unless a doc
 * genuinely cannot title itself: an entry here silently wins over the file, so
 * a stale one outlives the doc it describes. The previous set named six files
 * that had since moved to `docs/history/`, which `readdir` no longer returns.
 */
export const TITLE_OVERRIDES: Readonly<Record<string, { title: string; description: string }>> = {
  README: {
    description: 'Index of the living documentation — start here',
    title: 'Overview',
  },
};

const MAX_DESCRIPTION = 140;

/**
 * The first prose paragraph, flattened to one line and cut at a word boundary.
 * Front matter, headings, horizontal rules and fences are skipped; a blockquote
 * counts as prose with its marker removed.
 */
export function deriveDescription(raw: string): string {
  let body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  body = body.replace(/```[\s\S]*?```/g, '');
  const lines: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    const isRule = /^([-*_])(\s*\1){2,}$/.test(t);
    if (t === '' || /^#/.test(t) || isRule) {
      if (lines.length > 0) {
        break;
      }
      continue;
    }
    lines.push(t.replace(/^>\s?/, ''));
  }
  const text = lines
    .join(' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Emphasis markers only: an underscore inside a word (AUTO_SWE_TOKEN) is part of it.
    .replace(/[*`]/g, '')
    .replace(/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= MAX_DESCRIPTION) {
    return text;
  }
  const cut = text.slice(0, MAX_DESCRIPTION);
  const space = cut.lastIndexOf(' ');
  return `${(space > 60 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/** A doc's title and description: its override, else its `# heading` and first paragraph. */
export function docMeta(slug: string, raw: string): DocMeta {
  const override = TITLE_OVERRIDES[slug];
  if (override) {
    return { slug, ...override };
  }
  const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug;
  return { description: deriveDescription(raw), slug, title };
}

/** Slugs shown first on the docs index, in this order; everything else follows by title. */
const PINNED_SLUGS = ['README', 'quickstart', 'product-overview'];

export function orderDocs<T extends DocMeta>(docs: T[]): T[] {
  const rank = (slug: string) => {
    const i = PINNED_SLUGS.indexOf(slug);
    return i === -1 ? PINNED_SLUGS.length : i;
  };
  return [...docs].sort((a, b) => rank(a.slug) - rank(b.slug) || a.title.localeCompare(b.title));
}

/** The served slugs in `dir`: its top-level `.md` files whose names are valid slugs. */
export async function listDocSlugs(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.replace(/\.md$/, ''))
    .filter((slug) => DOC_SLUG_RE.test(slug));
}

/** One served doc, or null when the slug is not one or the file cannot be read. */
export async function readDoc(dir: string, slug: string): Promise<Doc | null> {
  if (!DOC_SLUG_RE.test(slug)) {
    return null;
  }
  try {
    const content = await readFile(path.join(dir, `${slug}.md`), 'utf8');
    return { ...docMeta(slug, content), content };
  } catch {
    return null;
  }
}

/** Every served doc in `dir`, in index order. */
export async function readDocs(dir: string): Promise<Doc[]> {
  const docs = await Promise.all((await listDocSlugs(dir)).map((slug) => readDoc(dir, slug)));
  return orderDocs(docs.filter((d): d is Doc => d !== null));
}

/** The search index over every served doc in `dir`. */
export async function buildDocSearchIndexFromDir(dir: string): Promise<SearchIndex> {
  return buildSearchIndexAsync(await readDocs(dir));
}
