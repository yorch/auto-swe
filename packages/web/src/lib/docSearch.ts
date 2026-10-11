/**
 * Full-text search over the served docs. Pure: no file access, so the index is built on the
 * server (see `loadDocSearchIndex` in `docs.ts`) and searched in the browser.
 *
 * Each doc is cut into sections at its h2/h3 headings. A section carries the heading id the
 * renderer gives that heading (`extractToc` walks the same parse and de-duplicates the same
 * way), so a result links straight to `/docs/<slug>#<anchor>`. The text before a doc's first
 * h2/h3 is a section with no anchor and links to the doc itself.
 */
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { extractToc } from './docToc';

export interface SearchIndex {
  docs: { slug: string; title: string }[];
  sections: SearchSection[];
}

export interface SearchSection {
  /** Index into `docs`. */
  doc: number;
  /** The section's heading text, or null for the text before a doc's first h2/h3. */
  heading: string | null;
  /** Heading id to deep-link to, or null for the doc's lead. */
  anchor: string | null;
  /** The section's prose as plain text: no code blocks, link targets, table syntax or markup. */
  text: string;
}

/** A run of text, flagged when it matched a search term. Render `match` runs as `<mark>`. */
export interface Segment {
  text: string;
  match: boolean;
}

export interface SearchResult {
  slug: string;
  anchor: string | null;
  title: Segment[];
  heading: Segment[] | null;
  snippet: Segment[];
}

export const MAX_RESULTS = 20;
const SNIPPET_CHARS = 180;

interface MdNode {
  type: string;
  depth?: number;
  value?: string;
  children?: MdNode[];
}

/** Node types whose content is not prose: fenced/indented code, raw HTML, images, rules. */
const SKIPPED = new Set(['code', 'html', 'image', 'imageReference', 'thematicBreak', 'yaml']);

/** Plain text of a node. Children are joined with a space so words from adjacent blocks or cells do not fuse. */
function plain(node: MdNode): string {
  if (SKIPPED.has(node.type)) {
    return '';
  }
  if (node.type === 'text' || node.type === 'inlineCode') {
    return node.value ?? '';
  }
  // Inline wrappers (emphasis, links) join without a space; everything else is a block.
  const inline = node.type === 'emphasis' || node.type === 'strong' || node.type === 'link';
  return (node.children ?? []).map(plain).join(inline ? '' : ' ');
}

function isSectionHeading(node: MdNode): boolean {
  return node.type === 'heading' && (node.depth === 2 || node.depth === 3);
}

function countHeadings(node: MdNode): number {
  return (
    (isSectionHeading(node) ? 1 : 0) +
    (node.children ?? []).reduce((n, child) => n + countHeadings(child), 0)
  );
}

function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/ ([.,;:!?)])/g, '$1')
    .replace(/\( /g, '(')
    .trim();
}

/** Cut one doc's Markdown into heading-anchored plain-text sections. */
export function indexDoc(markdown: string): Omit<SearchSection, 'doc'>[] {
  const root = unified().use(remarkParse).use(remarkGfm).parse(markdown) as unknown as MdNode;
  const toc = extractToc(markdown);
  const sections: Omit<SearchSection, 'doc'>[] = [];
  let heading: string | null = null;
  let anchor: string | null = null;
  let parts: string[] = [];
  let next = 0;

  const flush = () => {
    const text = tidy(parts.join(' '));
    if (text || heading) {
      sections.push({ anchor, heading, text });
    }
    parts = [];
  };

  for (const node of root.children ?? []) {
    if (isSectionHeading(node)) {
      flush();
      const entry = toc[next++];
      heading = entry?.text ?? tidy(plain(node));
      anchor = entry?.id ?? null;
      continue;
    }
    if (node.type === 'heading' && node.depth === 1) {
      continue; // the doc title is searched as the title
    }
    // A heading nested in a blockquote still consumes an id; stay in step with the renderer.
    next += countHeadings(node);
    parts.push(plain(node));
  }
  flush();
  return sections;
}

export function buildSearchIndex(
  docs: { slug: string; title: string; content: string }[]
): SearchIndex {
  const index: SearchIndex = { docs: [], sections: [] };
  for (const doc of docs) {
    const i = index.docs.push({ slug: doc.slug, title: doc.title }) - 1;
    for (const section of indexDoc(doc.content)) {
      index.sections.push({ doc: i, ...section });
    }
  }
  return index;
}

/** Lower-cased, de-duplicated, whitespace-separated terms. */
export function tokenize(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split `text` into runs, flagging every occurrence of a term. Never builds HTML. */
export function highlight(text: string, terms: string[]): Segment[] {
  if (text === '') {
    return [];
  }
  if (terms.length === 0) {
    return [{ match: false, text }];
  }
  // Longest first so a term that contains another is matched whole.
  const pattern = new RegExp(
    [...terms]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|'),
    'gi'
  );
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) {
      out.push({ match: false, text: text.slice(last, m.index) });
    }
    out.push({ match: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push({ match: false, text: text.slice(last) });
  }
  return out;
}

/** A window of about `SNIPPET_CHARS` around the first body match, on word boundaries. */
function snippetOf(text: string, terms: string[]): string {
  if (text.length <= SNIPPET_CHARS) {
    return text;
  }
  const lower = text.toLowerCase();
  const hits = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const at = hits.length > 0 ? Math.min(...hits) : 0;
  let start = Math.max(0, at - 50);
  let end = Math.min(text.length, start + SNIPPET_CHARS);
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space >= 0 && space < at) {
      start = space + 1;
    }
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > at) {
      end = space;
    }
  }
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

interface Lowered {
  titles: string[];
  headings: string[];
  bodies: string[];
}

/** Lower-cased corpus, built once per loaded index rather than on every keystroke. */
const loweredCache = new WeakMap<SearchIndex, Lowered>();

function lowered(index: SearchIndex): Lowered {
  let cached = loweredCache.get(index);
  if (!cached) {
    cached = {
      bodies: index.sections.map((s) => s.text.toLowerCase()),
      headings: index.sections.map((s) => (s.heading ?? '').toLowerCase()),
      titles: index.docs.map((d) => d.title.toLowerCase()),
    };
    loweredCache.set(index, cached);
  }
  return cached;
}

const TITLE_WEIGHT = 10;
const HEADING_WEIGHT = 5;
const BODY_WEIGHT = 1;

/**
 * Sections that contain every term (in the doc title, the heading or the body, in any mix),
 * best first. A term in the title outranks one in the heading, which outranks the body; ties
 * keep document order. At most `limit` results.
 */
export function searchDocs(index: SearchIndex, query: string, limit = MAX_RESULTS): SearchResult[] {
  const terms = tokenize(query);
  if (terms.length === 0) {
    return [];
  }
  const low = lowered(index);
  const scored: { score: number; order: number; section: SearchSection }[] = [];
  index.sections.forEach((section, order) => {
    const doc = index.docs[section.doc];
    if (!doc) {
      return;
    }
    const title = low.titles[section.doc] ?? '';
    const heading = low.headings[order] ?? '';
    const body = low.bodies[order] ?? '';
    let score = 0;
    for (const term of terms) {
      const inTitle = title.includes(term);
      const inHeading = heading.includes(term);
      const inBody = body.includes(term);
      if (!(inTitle || inHeading || inBody)) {
        return;
      }
      score +=
        (inTitle ? TITLE_WEIGHT : 0) +
        (inHeading ? HEADING_WEIGHT : 0) +
        (inBody ? BODY_WEIGHT : 0);
    }
    scored.push({ order, score, section });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, Math.max(0, limit)).map(({ section }) => {
    const doc = index.docs[section.doc] as { slug: string; title: string };
    return {
      anchor: section.anchor,
      heading: section.heading === null ? null : highlight(section.heading, terms),
      slug: doc.slug,
      snippet: highlight(snippetOf(section.text, terms), terms),
      title: highlight(doc.title, terms),
    };
  });
}
