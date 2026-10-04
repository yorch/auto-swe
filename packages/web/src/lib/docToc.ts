/**
 * The in-page table of contents for a doc. Headings are found in the Markdown
 * source and the renderer gives each the same id, using the same de-duplication,
 * so a contents link lands on the heading it names.
 */
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

export function extractToc(markdown: string): TocEntry[] {
  const nextId = headingIdFactory();
  const entries: TocEntry[] = [];
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      fence = fence === null ? fenceMatch[1][0] : fence === fenceMatch[1][0] ? null : fence;
      continue;
    }
    if (fence) {
      continue;
    }
    const m = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      const text = headingText(m[2]);
      // Every h2/h3 consumes an id, listed or not, to stay in step with the renderer.
      entries.push({ id: nextId(text), level: m[1].length as 2 | 3, text });
    }
  }
  return entries;
}
