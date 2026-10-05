/**
 * The in-page table of contents for a doc. Headings are found in the Markdown
 * source and the renderer gives each the same id, using the same de-duplication,
 * so a contents link lands on the heading it names.
 */
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

export interface TocEntry {
  id: string;
  level: 2 | 3;
  text: string;
}

/** Plain text of a heading's inline Markdown: links, code spans and emphasis reduced to their words. */
export function headingText(raw: string): string {
  return raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim();
}

export function slugifyHeading(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-') || 'section'
  );
}

/** Returns a function that hands out unique ids in call order ("intro", "intro-1", …). */
export function headingIdFactory(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = slugifyHeading(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}

/** The slice of an mdast node the heading walk reads. */
interface MdNode {
  type: string;
  depth?: number;
  value?: string;
  children?: MdNode[];
}

/**
 * The text the renderer sees inside a node. Mirrors what React gets as a
 * heading's children: text and code spans count, images and raw HTML (which
 * `react-markdown` does not render) do not.
 */
function mdText(node: MdNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') {
    return node.value ?? '';
  }
  if (node.type === 'image' || node.type === 'html') {
    return '';
  }
  return (node.children ?? []).map(mdText).join('');
}

function collectHeadings(node: MdNode, out: MdNode[]) {
  if (node.type === 'heading' && (node.depth === 2 || node.depth === 3)) {
    out.push(node);
  }
  for (const child of node.children ?? []) {
    collectHeadings(child, out);
  }
}

/**
 * The contents list, taken from the same parse the renderer uses (remark with GFM),
 * so setext headings count and headings inside blockquotes or HTML blocks are
 * treated exactly as they are rendered. Document order matches render order.
 */
export function extractToc(markdown: string): TocEntry[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as unknown as MdNode;
  const headings: MdNode[] = [];
  collectHeadings(tree, headings);
  const nextId = headingIdFactory();
  // Every h2/h3 consumes an id, listed or not, to stay in step with the renderer.
  return headings.map((heading) => {
    const text = headingText(mdText(heading));
    return { id: nextId(text), level: heading.depth as 2 | 3, text };
  });
}
