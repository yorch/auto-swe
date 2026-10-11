/**
 * Full-text search over the served docs. Pure: no file access. The index is built once per server
 * process (see `loadDocSearchIndex` in `docs.ts`) and searched there by `app/docs/search/route.ts`;
 * the browser only ever receives the top results.
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
  /** Lower-cased text and stemmed word sets: one entry per doc (titles) or per section. */
  prepared: {
    titles: Field[];
    headings: Field[];
    bodies: Field[];
  };
}

/** A searchable string: its lower-cased text and the stems of its words. */
interface Field {
  lower: string;
  stems: Set<string>;
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

function emptyIndex(): SearchIndex {
  return { docs: [], prepared: { bodies: [], headings: [], titles: [] }, sections: [] };
}

function addDoc(index: SearchIndex, doc: { slug: string; title: string; content: string }): void {
  const i = index.docs.push({ slug: doc.slug, title: doc.title }) - 1;
  index.prepared.titles.push(field(doc.title));
  for (const section of indexDoc(doc.content)) {
    index.sections.push({ doc: i, ...section });
    index.prepared.headings.push(field(section.heading ?? ''));
    index.prepared.bodies.push(field(section.text));
  }
}

export function buildSearchIndex(
  docs: { slug: string; title: string; content: string }[]
): SearchIndex {
  const index = emptyIndex();
  for (const doc of docs) {
    addDoc(index, doc);
  }
  return index;
}

/**
 * The same index, built one doc at a time with a turn of the event loop between docs, so the
 * first search does not hold the server's other requests for the whole build.
 */
export async function buildSearchIndexAsync(
  docs: { slug: string; title: string; content: string }[]
): Promise<SearchIndex> {
  const index = emptyIndex();
  for (const doc of docs) {
    addDoc(index, doc);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return index;
}

/** Longest query the search considers; the route and the client both cut to this. */
export const MAX_QUERY_CHARS = 100;
/** Most terms a query is split into; later ones are ignored. */
export const MAX_QUERY_TERMS = 8;

/** Lower-cased, de-duplicated, whitespace-separated terms, at most `MAX_QUERY_TERMS`. */
export function tokenize(query: string): string[] {
  const terms = query.slice(0, MAX_QUERY_CHARS).toLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set(terms)].slice(0, MAX_QUERY_TERMS);
}

const VOWELS = /[aeiou]/;

/** Words the suffix rules would damage: they are their own singular, or end like a plural. */
const UNSTEMMED = new Set(['series', 'species', 'news', 'does', 'goes']);

/**
 * A light, deterministic English stem: plural (-s, -es, -ies), -ing, -ed, then a trailing -e, so
 * `approve`, `approves`, `approved` and `approving` all become `approv`, and `case` and `cases`
 * both become `cas`. `-es` is dropped whole only after `ss`, `x`, `zz`, `ch` or `sh`
 * (`boxes`, `passes`); anywhere else only the `s` goes (`cases`, `sizes`, `uses`). It is only
 * ever used to compare two words for equality, never shown. Anything that is not a plain run of
 * letters (an identifier such as `AUTO_SWE_TOKEN` or `v2`), any word of three letters or fewer
 * and the few words in `UNSTEMMED` is returned unchanged, and a suffix is only removed when a
 * stem with a vowel remains.
 */
export function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= 3 || !/^[a-z]+$/.test(w) || UNSTEMMED.has(w)) {
    return w;
  }
  let s = w;
  if (s.endsWith('ies') && s.length > 4) {
    s = `${s.slice(0, -3)}y`;
  } else if (s.endsWith('ing') && s.length >= 6 && VOWELS.test(s.slice(0, -3))) {
    s = undouble(s.slice(0, -3));
  } else if (s.endsWith('ed') && s.length >= 5 && VOWELS.test(s.slice(0, -2))) {
    s = undouble(s.slice(0, -2));
  } else if (/(?:ss|zz|x|ch|sh)es$/.test(s)) {
    s = s.slice(0, -2);
  } else if (s.endsWith('s') && !/(?:ss|us|is)$/.test(s)) {
    s = s.slice(0, -1);
  }
  return s.length >= 4 && s.endsWith('e') ? s.slice(0, -1) : s;
}

/** `runn` -> `run`, but `skill`, `pass` and `buzz` keep their double letter. */
function undouble(s: string): string {
  const last = s.at(-1) ?? '';
  const doubled = s.length > 3 && last === s.at(-2) && /[b-df-hj-np-tv-xz]/.test(last);
  return doubled && !'lsz'.includes(last) ? s.slice(0, -1) : s;
}

/** Every run of letters in `text`, with its position. */
function words(text: string): { start: number; end: number; word: string }[] {
  return [...text.matchAll(/[A-Za-z]+/g)].map((m) => ({
    end: m.index + m[0].length,
    start: m.index,
    word: m[0],
  }));
}

/**
 * Lower-case `text` without changing its length, so an offset found in the result is an offset
 * in the original. `toLowerCase` can grow a string (`İ` becomes two code units); a character
 * that would grow is kept as written.
 */
function fold(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) {
    return lower;
  }
  return text.replace(/[\s\S]/g, (c) => {
    const l = c.toLowerCase();
    return l.length === c.length ? l : c;
  });
}

function field(text: string): Field {
  return { lower: fold(text), stems: new Set(words(text).map((w) => stem(w.word))) };
}

/** A term matches a field as a substring (identifiers, partial words) or as a word with the same stem. */
function fieldHas(f: Field, term: string, termStem: string): boolean {
  return f.lower.includes(term) || f.stems.has(termStem);
}

/**
 * Merged `[start, end)` ranges of `text` that match a term: every literal occurrence, and every
 * whole word whose stem equals the term's stem. Both are taken from the original text, so
 * the highlight shows what the author wrote (`approving` for a search of `approved`).
 */
function matchRanges(text: string, terms: string[]): [number, number][] {
  const lower = fold(text);
  const termStems = terms.map(stem);
  const found: [number, number][] = [];
  for (const term of terms) {
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + 1)) {
      found.push([at, at + term.length]);
    }
  }
  // A word that already contains a term literally keeps the exact-text highlight (`budg` in
  // `budget`); only a word matched through its stem alone is marked whole.
  for (const w of words(text)) {
    const ws = stem(w.word);
    const lowerWord = fold(w.word);
    if (terms.some((t, i) => ws === termStems[i] && !lowerWord.includes(t))) {
      found.push([w.start, w.end]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const r of found) {
    const prev = merged.at(-1);
    if (prev && r[0] <= prev[1]) {
      prev[1] = Math.max(prev[1], r[1]);
    } else {
      merged.push([r[0], r[1]]);
    }
  }
  return merged;
}

/** Split `text` into runs, flagging every match of a term (or of its stem). Never builds HTML. */
export function highlight(text: string, terms: string[]): Segment[] {
  if (text === '') {
    return [];
  }
  const out: Segment[] = [];
  let last = 0;
  for (const [start, end] of matchRanges(text, terms)) {
    if (start > last) {
      out.push({ match: false, text: text.slice(last, start) });
    }
    out.push({ match: true, text: text.slice(start, end) });
    last = end;
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
  const at = matchRanges(text, terms)[0]?.[0] ?? 0;
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

const TITLE_WEIGHT = 10;
const HEADING_WEIGHT = 5;
const BODY_WEIGHT = 1;

/**
 * Sections that contain every term (in the doc title, the heading or the body, in any mix),
 * best first. A term matches as a substring or by word stem, so `skills` finds `skill` and
 * `approved` finds `approving`. A term in the title outranks one in the heading, which outranks
 * the body; ties keep document order. At most `limit` results.
 */
export function searchDocs(index: SearchIndex, query: string, limit = MAX_RESULTS): SearchResult[] {
  const terms = tokenize(query);
  if (terms.length === 0) {
    return [];
  }
  const termStems = terms.map(stem);
  const scored: { score: number; order: number; section: SearchSection }[] = [];
  index.sections.forEach((section, order) => {
    const title = index.prepared.titles[section.doc];
    const heading = index.prepared.headings[order];
    const body = index.prepared.bodies[order];
    if (!(title && heading && body)) {
      return;
    }
    let score = 0;
    for (const [i, term] of terms.entries()) {
      const ts = termStems[i] as string;
      const inTitle = fieldHas(title, term, ts);
      const inHeading = fieldHas(heading, term, ts);
      const inBody = fieldHas(body, term, ts);
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
