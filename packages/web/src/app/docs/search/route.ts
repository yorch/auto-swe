import { MAX_QUERY_CHARS, MAX_RESULTS, searchDocs } from '@auto-swe/shared/lib/docSearch';
import type { NextRequest } from 'next/server';
import { loadDocSearchIndex } from '@/lib/docs';

/** Answers per request, so it must not be prerendered at `next build`. */
export const dynamic = 'force-dynamic';

/**
 * `GET /docs/search?q=…`: the best sections of the served docs for a query, as highlight
 * segments (never HTML). The index is built once per server process on the first request, so
 * the browser downloads the few results it shows rather than the text of every doc.
 *
 * The path sits under `/docs`, which `proxy.ts` leaves behind the session check (only `/api`,
 * `/login` and a few others are public to it). A static `search` segment wins over `[slug]`, and
 * `lib/docSearch.docs.test.tsx` keeps a doc from ever being named `search`.
 *
 * `q` is trimmed and cut to `MAX_QUERY_CHARS`; an empty or missing `q` answers no results.
 */
export async function GET(request: NextRequest) {
  const q = (request.nextUrl.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY_CHARS);
  if (q === '') {
    return Response.json({ results: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const results = searchDocs(await loadDocSearchIndex(), q, MAX_RESULTS);
    return Response.json({ results }, { headers: { 'Cache-Control': 'private, max-age=60' } });
  } catch (err) {
    console.error('[docs/search] index build failed', err);
    return Response.json(
      { error: 'Doc search is unavailable.' },
      { headers: { 'Cache-Control': 'no-store' }, status: 500 }
    );
  }
}
