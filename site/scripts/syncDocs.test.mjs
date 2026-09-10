import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DOCS_DIR,
  DOCS_INDEX,
  DOCS_ROUTE_PREFIX,
  EXTERNAL_PAGES,
  SIDEBAR,
  siteUrl,
} from './manifest.mjs';
import { extractFrontmatter } from './syncDocs.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('extractFrontmatter', () => {
  it('takes the title from the H1 and removes it from the body', () => {
    const { body, title } = extractFrontmatter('# System Architecture\n\nHow it fits together.\n');
    expect(title).toBe('System Architecture');
    expect(body).toBe('How it fits together.\n');
  });

  it('strips inline markdown from the title', () => {
    expect(extractFrontmatter('# Agents, `Tools` & **Skills**\n').title).toBe(
      'Agents, Tools & Skills'
    );
  });

  // The `---` immediately under an H1 is the shape of nearly every doc here, and
  // reading it as the summary is what the first version of this did.
  it('skips a horizontal rule when looking for the lead', () => {
    const { description } = extractFrontmatter(
      '# Title\n\n---\n\nThe actual summary of this document.\n'
    );
    expect(description).toBe('The actual summary of this document.');
  });

  it('uses an opening blockquote as the lead, without its markers', () => {
    const { description } = extractFrontmatter(
      '# Title\n\n> Comprehensive reference for the agent layer.\n\nBody text follows here.\n'
    );
    expect(description).toBe('Comprehensive reference for the agent layer.');
  });

  it('skips a table, a heading, and a fence to reach real prose', () => {
    const { description } = extractFrontmatter(
      '# Title\n\n## Section\n\n| a | b |\n\n```ts\nconst x = 1;\n```\n\nThis sentence is the summary.\n'
    );
    expect(description).toBe('This sentence is the summary.');
  });

  it('truncates a long lead at a word boundary', () => {
    const long = `# T\n\n${'word '.repeat(80)}\n`;
    const { description } = extractFrontmatter(long);
    expect(description.length).toBeLessThanOrEqual(161);
    expect(description.endsWith('…')).toBe(true);
    expect(description).not.toMatch(/wor…$/);
  });

  it('returns empty strings rather than throwing on a doc with no H1', () => {
    expect(extractFrontmatter('Just a line.\n')).toMatchObject({ title: '' });
  });
});

describe('siteUrl', () => {
  it('builds a trailing-slash URL under the Pages base path', () => {
    expect(siteUrl('docs/agents')).toBe('/auto-swe/docs/agents/');
    expect(siteUrl('docs')).toBe('/auto-swe/docs/');
    expect(siteUrl('')).toBe('/auto-swe/');
  });
});

/**
 * The sidebar is hand-ordered, because a reader should meet these docs in an
 * order alphabetising cannot produce. That makes it the one thing here that a
 * new doc silently falls out of — the page still builds and still resolves by
 * URL, it is simply absent from the navigation.
 *
 * The sync script enforces this at build time. Asserting it here as well means
 * `yarn test` reports it as a named failure rather than the site build dying
 * partway through with a stack trace.
 */
describe('sidebar coverage', () => {
  const publishedSlugs = () => {
    const docs = readdirSync(join(REPO_ROOT, DOCS_DIR))
      .filter((name) => name.endsWith('.md') && /^[a-z0-9][a-z0-9-]*\.md$/i.test(name))
      .map((name) =>
        `${DOCS_DIR}/${name}` === DOCS_INDEX.source
          ? DOCS_INDEX.slug
          : `${DOCS_ROUTE_PREFIX}/${name.replace(/\.md$/, '')}`
      );
    return [...docs, ...EXTERNAL_PAGES.map((page) => page.slug)];
  };

  it('lists every published page exactly once', () => {
    const listed = SIDEBAR.flatMap((group) => group.slugs);
    expect([...listed].sort()).toEqual([...publishedSlugs()].sort());
  });

  it('names no page that is not published', () => {
    const published = new Set(publishedSlugs());
    const orphaned = SIDEBAR.flatMap((group) => group.slugs).filter((s) => !published.has(s));
    expect(orphaned).toEqual([]);
  });
});
