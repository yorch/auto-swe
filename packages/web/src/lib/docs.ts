import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { cache } from 'react';

export type DocMeta = {
  slug: string;
  title: string;
  description: string;
};

export type Doc = DocMeta & {
  content: string;
};

/**
 * Only the top level of `docs/` is served. `docs/history/` is frozen by
 * convention — publishing it to product users would advertise superseded
 * behaviour as current — and `docs/redesign/` is image reference material.
 */
const DOCS_DIR = path.resolve(process.cwd(), '../../docs');

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;

/**
 * Titles the doc's own `# heading` gets wrong. Keep this empty unless a doc
 * genuinely cannot title itself: an entry here silently wins over the file, so
 * a stale one outlives the doc it describes. The previous set named six files
 * that had since moved to `docs/history/`, which `readdir` no longer returns.
 */
const TITLE_OVERRIDES: Record<string, { title: string; description: string }> = {
  README: {
    description: 'Index of the living documentation — start here',
    title: 'Overview',
  },
};

function deriveMeta(slug: string, raw: string): DocMeta {
  const override = TITLE_OVERRIDES[slug];
  if (override) {
    return { slug, ...override };
  }

  const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug;
  const firstPara = raw.match(/^(?!#|>|\s*$).+$/m)?.[0]?.trim() ?? '';
  const description = firstPara.replace(/[*_`]/g, '').slice(0, 140);

  return { description, slug, title };
}

export const listDocs = cache(async (): Promise<DocMeta[]> => {
  const entries = await readdir(DOCS_DIR);
  const docs = await Promise.all(
    entries
      .filter((name) => name.endsWith('.md'))
      .map((name) => ({ name, slug: name.replace(/\.md$/, '') }))
      .filter(({ slug }) => SLUG_RE.test(slug))
      .map(async ({ name, slug }) => {
        const override = TITLE_OVERRIDES[slug];
        if (override) {
          return { slug, ...override };
        }
        const raw = await readFile(path.join(DOCS_DIR, name), 'utf8');
        return deriveMeta(slug, raw);
      })
  );
  return docs.sort((a, b) => a.title.localeCompare(b.title));
});

/**
 * Slugs `/docs/[slug]` will render. The Markdown renderer needs this to tell a
 * cross-doc link it can rewrite from one it must degrade to plain text.
 */
export const servedDocSlugs = cache(async (): Promise<ReadonlySet<string>> => {
  const docs = await listDocs();
  return new Set(docs.map((d) => d.slug));
});

export const getDoc = cache(async (slug: string): Promise<Doc | null> => {
  if (!SLUG_RE.test(slug)) {
    return null;
  }
  try {
    const content = await readFile(path.join(DOCS_DIR, `${slug}.md`), 'utf8');
    return { ...deriveMeta(slug, content), content };
  } catch {
    return null;
  }
});
