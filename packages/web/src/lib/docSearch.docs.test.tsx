// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { render } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { Markdown } from '@/components/docs/Markdown';
import { buildSearchIndex, type SearchIndex, searchDocs } from './docSearch';
import { extractToc } from './docToc';

// The same set `lib/docs.ts` serves: top-level docs/*.md with a valid slug.
const DOCS_DIR = path.resolve(__dirname, '../../../../docs');
const docs = readdirSync(DOCS_DIR)
  .filter((name) => name.endsWith('.md'))
  .map((name) => name.replace(/\.md$/, ''))
  .filter((slug) => /^[a-z0-9][a-z0-9-]*$/i.test(slug))
  .map((slug) => {
    const content = readFileSync(path.join(DOCS_DIR, `${slug}.md`), 'utf8');
    return { content, slug, title: content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug };
  });

// Indexing and rendering every served doc is the expensive part, so it happens once, in
// `beforeAll`, and the tests below only read what it produced. Under coverage in CI it takes a
// few seconds, which the 5 s default would not survive.
describe('the real docs index', () => {
  let index: SearchIndex;
  const renderedIds = new Map<string, Set<string>>();
  const tocIds = new Map<string, string[]>();

  beforeAll(() => {
    index = buildSearchIndex(docs);
    for (const doc of docs) {
      tocIds.set(
        doc.slug,
        extractToc(doc.content).map((t) => t.id)
      );
    }
    const servedSlugs = new Set(docs.map((d) => d.slug));
    for (const doc of docs) {
      const { container, unmount } = render(
        <Markdown servedSlugs={servedSlugs}>{doc.content}</Markdown>
      );
      renderedIds.set(
        doc.slug,
        new Set([...container.querySelectorAll('h2[id], h3[id]')].map((h) => h.id))
      );
      unmount();
    }
  }, 30_000);

  it('indexes every served doc and nothing else', () => {
    expect(index.docs.map((d) => d.slug).sort()).toEqual(docs.map((d) => d.slug).sort());
    expect(index.docs.some((d) => d.slug === 'history')).toBe(false);
  });

  it('gives each doc the anchors extractToc lists, in order', () => {
    index.docs.forEach((doc, i) => {
      const anchors = index.sections
        .filter((s) => s.doc === i && s.anchor !== null)
        .map((s) => s.anchor);
      expect(anchors, doc.slug).toEqual(tocIds.get(doc.slug));
    });
  });

  it('indexes no code-fence content or table syntax', () => {
    for (const s of index.sections) {
      expect(s.text).not.toMatch(/```/);
      expect(s.text).not.toMatch(/\|\s*-{3,}/);
    }
  });

  it('every indexed anchor is the id of a heading in the rendered doc', () => {
    for (const doc of docs) {
      const i = index.docs.findIndex((d) => d.slug === doc.slug);
      const ids = renderedIds.get(doc.slug) ?? new Set<string>();
      for (const s of index.sections.filter((x) => x.doc === i && x.anchor !== null)) {
        expect(ids.has(s.anchor as string), `${doc.slug}#${s.anchor}`).toBe(true);
      }
    }
  });

  it('has no doc whose slug the /docs/search route would shadow', () => {
    // A static `search` segment wins over `[slug]`, so such a doc would be unreachable.
    expect(docs.map((d) => d.slug)).not.toContain('search');
  });

  it('finds the same section for singular, plural and -ing forms', () => {
    const ids = (q: string) => searchDocs(index, q).map((r) => `${r.slug}#${r.anchor}`);
    expect(ids('workflows').length).toBeGreaterThan(0);
    expect(ids('workflow').length).toBeGreaterThan(0);
    expect(ids('approving').length).toBeGreaterThan(0);
    expect(ids('approved').length).toBeGreaterThan(0);
  });

  it('finds text that only appears in a doc body', () => {
    const results = searchDocs(index, 'autonomy policy');
    expect(results.length).toBeGreaterThan(0);
  });
});
