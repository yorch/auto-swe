import path from 'node:path';
import {
  type Doc,
  type DocMeta,
  listDocSlugs,
  orderDocs,
  readDoc,
} from '@auto-swe/shared/lib/docFiles';
import { buildSearchIndexAsync, type SearchIndex } from '@auto-swe/shared/lib/docSearch';
import { cache } from 'react';

export type { Doc, DocMeta } from '@auto-swe/shared/lib/docFiles';

/** The repository's `docs/`; only its top level is served (`@auto-swe/shared/lib/docFiles`). */
const DOCS_DIR = path.resolve(process.cwd(), '../../docs');

export const listDocs = cache(async (): Promise<DocMeta[]> => {
  const docs = await Promise.all((await listDocSlugs(DOCS_DIR)).map((slug) => getDoc(slug)));
  return orderDocs(docs.filter((d): d is Doc => d !== null).map(({ content: _, ...meta }) => meta));
});

/**
 * Slugs `/docs/[slug]` will render. The Markdown renderer needs this to tell a
 * cross-doc link it can rewrite from one it must degrade to plain text.
 */
export const servedDocSlugs = cache(async (): Promise<ReadonlySet<string>> => {
  const docs = await listDocs();
  return new Set(docs.map((d) => d.slug));
});

export const getDoc = cache((slug: string): Promise<Doc | null> => readDoc(DOCS_DIR, slug));

/**
 * Held on `globalThis` rather than in a module variable: Next bundles `instrumentation.ts` apart
 * from the route handlers, so each would get its own copy of this module and the start-up
 * warm-up would build an index the search route never reads.
 */
const INDEX_KEY = Symbol.for('auto-swe.docSearchIndex');
const holder = globalThis as { [INDEX_KEY]?: Promise<SearchIndex> };

/**
 * The search index over every served doc, built from the same files `/docs/[slug]` renders.
 * Built at start-up (`instrumentation.ts`) or on first use, and kept for the life of the process
 * (the docs ship in the image and do not change while it runs), so it is a process-wide memo
 * rather than React's per-request `cache`.
 * A failed build is not kept: the next search tries again.
 */
export function loadDocSearchIndex(): Promise<SearchIndex> {
  const kept = holder[INDEX_KEY];
  if (kept) {
    return kept;
  }
  const building: Promise<SearchIndex> = (async () => {
    const metas = await listDocs();
    const docs = await Promise.all(metas.map((m) => getDoc(m.slug)));
    return buildSearchIndexAsync(docs.filter((d): d is Doc => d !== null));
  })().catch((error: unknown) => {
    if (holder[INDEX_KEY] === building) {
      holder[INDEX_KEY] = undefined;
    }
    throw error;
  });
  holder[INDEX_KEY] = building;
  return building;
}
