// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from '@/components/docs/Markdown';
import { buildSearchIndex, searchDocs } from './docSearch';
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

describe('the real docs index', () => {
  const index = buildSearchIndex(docs);

  it('indexes every served doc and nothing else', () => {
    expect(index.docs.map((d) => d.slug).sort()).toEqual(docs.map((d) => d.slug).sort());
    expect(index.docs.some((d) => d.slug === 'history')).toBe(false);
  });

  it('gives each doc the anchors extractToc lists, in order', () => {
    index.docs.forEach((doc, i) => {
      const source = docs.find((d) => d.slug === doc.slug);
      const anchors = index.sections
        .filter((s) => s.doc === i && s.anchor !== null)
        .map((s) => s.anchor);
      expect(anchors, doc.slug).toEqual(extractToc(source?.content ?? '').map((t) => t.id));
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
      const { container, unmount } = render(
        <Markdown servedSlugs={new Set(docs.map((d) => d.slug))}>{doc.content}</Markdown>
      );
      const ids = new Set([...container.querySelectorAll('h2[id], h3[id]')].map((h) => h.id));
      for (const s of index.sections.filter((x) => x.doc === i && x.anchor !== null)) {
        expect(ids.has(s.anchor as string), `${doc.slug}#${s.anchor}`).toBe(true);
      }
      unmount();
    }
  });

  it('finds text that only appears in a doc body', () => {
    const results = searchDocs(index, 'autonomy policy');
    expect(results.length).toBeGreaterThan(0);
  });
});
