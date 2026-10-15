/**
 * Full-text search over the served docs. Pure: no file access. The dashboard builds the index once
 * per server process (`loadDocSearchIndex` in the web's `lib/docs.ts`) and searches it in
 * `app/docs/search/route.ts`, so the browser only ever receives the top results; the in-app
 * assistant's `searchDocs` tool builds the same index from the docs the worker image ships.
 *
 * Each doc is cut into sections at its h2/h3 headings. A section carries the heading id the
 * renderer gives that heading (`extractToc` walks the same parse and de-duplicates the same
 * way), so a result links straight to `/docs/<slug>#<anchor>`. The text before a doc's first
 * h2/h3 is a section with no anchor and links to the doc itself.
 */
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { tocFromTree } from './docToc.js';

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
  const toc = tocFromTree(root);
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

/** Words ending -ed that are not a past tense (`embed`, not `emb` + `ed`). */
const NOT_PAST_TENSE = new Set(['embed', 'hundred', 'indeed', 'naked', 'sacred', 'shred']);

/**
 * Nouns ending -ing that are not read as the verb's gerund, so `setting` is not the verb `set`
 * and `heading` is not `head`. They and their plurals match each other and nothing shorter.
 */
const NOUNS_IN_ING = new Set(['setting', 'heading', 'ending', 'meeting']);

/**
 * Singulars ending -as or -us whose plural adds `es` (`aliases`, `statuses`). A closed list,
 * because the ending alone cannot tell them from `cases`, `bases`, `causes` or `uses`.
 */
const SES_SINGULARS = new Set([
  'alias',
  'atlas',
  'bias',
  'bonus',
  'bus',
  'campus',
  'canvas',
  'census',
  'corpus',
  'focus',
  'radius',
  'status',
  'virus',
]);

/**
 * The forms a word is compared by: plural (-s, -es, -ies), -ing, -ed and -ied are removed, and
 * two words match when their form lists share a form (`sameStem`). `-ing` and `-ed` hide whether
 * the base ended in `e`, which is settled the way the Porter stemmer does: a doubled consonant
 * means there was none (`sitting` and `planned` come from `sit` and `plan`, never `site` or
 * `plane`); a one-syllable consonant-vowel-consonant base had one (`noted` is `note`, `rated` is
 * `rate`, `hoped` is `hope`, never `not`, `rat` or `hop`); any other base could be either, so
 * `approved` and `approving` carry `approv` and `approve`. A bare word is never reduced onto a
 * shorter one: `rate` is not `rat`, `base` is not `bas`, `here` is not `her`. `-ied` becomes `-y`
 * (`applied` is `apply`), `-ings` takes the forms of its `-ing` singular (`findings` and
 * `finding`), and `-es` is dropped whole after `ss`, `x`, `zz`, `ch`, `sh` and on a short list
 * of `-as`/`-us` nouns (`statuses`, `aliases`); anywhere else only the `s` goes (`cases`, `sizes`,
 * `uses`, `causes`). A few words that merely end like an inflection are left whole (`embed`,
 * `speed`, `setting`). Forms are only ever compared, never shown. Anything that is not a plain
 * run of letters (an identifier such as `AUTO_SWE_TOKEN` or `v2`), any word of three letters or
 * fewer and the few words in `UNSTEMMED` is its own only form, and a suffix is only removed when
 * a stem with a vowel remains.
 */
export function stemForms(word: string): string[] {
  const w = word.toLowerCase();
  if (w.length <= 3 || !/^[a-z]+$/.test(w) || UNSTEMMED.has(w)) {
    return [w];
  }
  if ((w.endsWith('ies') || w.endsWith('ied')) && w.length > 4) {
    return [`${w.slice(0, -3)}y`];
  }
  if (NOT_PAST_TENSE.has(w) || (w.endsWith('s') && NOT_PAST_TENSE.has(w.slice(0, -1)))) {
    return [w.endsWith('s') ? w.slice(0, -1) : w];
  }
  if (w.endsWith('ings') && w.length > 5) {
    return [...new Set([...stemForms(w.slice(0, -1)), w])];
  }
  if (NOUNS_IN_ING.has(w) || SES_SINGULARS.has(w)) {
    return [w];
  }
  const base = inflectionBase(w);
  if (base !== null) {
    return base;
  }
  if (/(?:ss|zz|x|ch|sh)es$/.test(w)) {
    return [w.slice(0, -2)];
  }
  if (w.endsWith('es') && SES_SINGULARS.has(w.slice(0, -2))) {
    return [w.slice(0, -2)];
  }
  if (w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) {
    return [w.slice(0, -1)];
  }
  return [w];
}

/**
 * The candidate bases of `w` without its -ing or -ed, or null when it has neither or nothing
 * word-like would remain. A vowel must remain, an `-eed` word (`speed`, `succeed`) is not a past
 * tense, and a base of two letters (`used`, `using`) must end in a consonant: `seed`, `being` and
 * `doing` are not `se`, `be` and `do` inflected.
 */
function inflectionBase(w: string): string[] | null {
  const cut = w.endsWith('ing') ? 3 : w.endsWith('ed') ? 2 : 0;
  if (cut === 0) {
    return null;
  }
  const raw = w.slice(0, -cut);
  if (!VOWELS.test(raw) || (cut === 2 && raw.endsWith('e'))) {
    return null;
  }
  const base = undouble(raw);
  if (base.length < 2 || (base.length < 3 && VOWELS.test(base.slice(-1)))) {
    return null;
  }
  if (base !== raw) {
    return [base];
  }
  // One syllable, consonant-vowel-consonant (`not`, `rat`, `hop`): only the `e` form is a word
  // that takes -ed or -ing without doubling.
  if (/^[^aeiou]+[aeiou][^aeiouwxy]$/.test(raw)) {
    return [`${raw}e`];
  }
  // A base shorter than three letters (`used` -> `us`) is not a word to match on its own.
  return base.length >= 3 ? [base, `${base}e`] : [`${base}e`];
}

/** True when two words share a stem form: `approved` and `approves`, but not `rate` and `rat`. */
export function sameStem(a: string, b: string): boolean {
  const forms = new Set(stemForms(a));
  return stemForms(b).some((f) => forms.has(f));
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
  return { lower: fold(text), stems: new Set(words(text).flatMap((w) => stemForms(w.word))) };
}

/** A term matches a field as a substring (identifiers, partial words) or as a word with the same stem. */
function fieldHas(f: Field, term: string, termForms: string[]): boolean {
  return f.lower.includes(term) || termForms.some((form) => f.stems.has(form));
}

/**
 * Merged `[start, end)` ranges of `text` that match a term: every literal occurrence, and every
 * whole word that shares a stem form with the term. Both are taken from the original text, so
 * the highlight shows what the author wrote (`approving` for a search of `approved`).
 */
function matchRanges(text: string, terms: string[]): [number, number][] {
  const lower = fold(text);
  const termForms = terms.map(stemForms);
  const found: [number, number][] = [];
  for (const term of terms) {
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + 1)) {
      found.push([at, at + term.length]);
    }
  }
  // A word that already contains a term literally keeps the exact-text highlight (`budg` in
  // `budget`); only a word matched through its stem alone is marked whole.
  for (const w of words(text)) {
    const ws = stemForms(w.word);
    const lowerWord = fold(w.word);
    if (
      terms.some(
        (t, i) => !lowerWord.includes(t) && ws.some((f) => (termForms[i] as string[]).includes(f))
      )
    ) {
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

/** A section a query matched, with the doc it belongs to. */
export interface RankedSection {
  section: SearchSection;
  doc: { slug: string; title: string };
  score: number;
}

/**
 * Sections that contain every term (in the doc title, the heading or the body, in any mix),
 * best first. A term matches as a substring or by word stem, so `skills` finds `skill` and
 * `approved` finds `approving`. A term in the title outranks one in the heading, which outranks
 * the body; ties keep document order. At most `limit` results.
 */
export function rankSections(
  index: SearchIndex,
  query: string,
  limit = MAX_RESULTS
): RankedSection[] {
  const terms = tokenize(query);
  if (terms.length === 0) {
    return [];
  }
  const termForms = terms.map(stemForms);
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
      const ts = termForms[i] as string[];
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
  return scored.slice(0, Math.max(0, limit)).map(({ score, section }) => ({
    doc: index.docs[section.doc] as { slug: string; title: string },
    score,
    section,
  }));
}

/** {@link rankSections}, as highlighted results for the docs search box. */
export function searchDocs(index: SearchIndex, query: string, limit = MAX_RESULTS): SearchResult[] {
  const terms = tokenize(query);
  return rankSections(index, query, limit).map(({ doc, section }) => ({
    anchor: section.anchor,
    heading: section.heading === null ? null : highlight(section.heading, terms),
    slug: doc.slug,
    snippet: highlight(snippetOf(section.text, terms), terms),
    title: highlight(doc.title, terms),
  }));
}

/** The dashboard link to a section: `/docs/<slug>`, with `#<anchor>` when it has a heading. */
export function sectionLink(slug: string, anchor: string | null): string {
  return anchor === null ? `/docs/${slug}` : `/docs/${slug}#${anchor}`;
}
