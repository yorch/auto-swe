import { loadDocSearchIndex } from '@/lib/docs';

/** Built once at `next build`; the docs do not change while the server runs. */
export const dynamic = 'force-static';

/**
 * The full-text search index for `/docs`. It is fetched lazily when a reader starts searching,
 * so the plain text of every doc is not part of the page's HTML. The proxy gives this path the
 * same session check as the doc pages beside it.
 */
export async function GET() {
  return Response.json(await loadDocSearchIndex());
}
