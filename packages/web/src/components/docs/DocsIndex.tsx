'use client';

import { MAX_QUERY_CHARS, type SearchResult, type Segment } from '@auto-swe/shared/lib/docSearch';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { docHref } from '@/components/ui/DocLink';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon, type IconName } from '@/components/ui/Icon';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import type { DocMeta } from '@/lib/docs';
import { cn, FOCUS_RING, plural } from '@/lib/utils';

/** Where the server-side full-text search answers (`app/docs/search/route.ts`). */
export const SEARCH_URL = '/docs/search';

/** How long typing must pause before the text search is requested. */
export const SEARCH_DEBOUNCE_MS = 200;

/**
 * Ask the server for the best sections for `query`. Rejects on a non-OK status or a body that is
 * not a result list (a login page after a redirect, say), and when `signal` aborts.
 */
export async function fetchSearchResults(
  query: string,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const res = await fetch(`${SEARCH_URL}?${new URLSearchParams({ q: query })}`, {
    credentials: 'same-origin',
    signal,
  });
  if (!(res.ok && res.headers.get('content-type')?.includes('application/json'))) {
    throw new Error(`doc search request failed: ${res.status}`);
  }
  const body = (await res.json()) as { results?: unknown };
  if (!Array.isArray(body.results)) {
    throw new Error('doc search returned an unexpected shape');
  }
  return body.results as SearchResult[];
}

type TextSearch =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'ready'; query: string; results: SearchResult[] }
  | { status: 'error'; query: string };

/** Text with the matched runs in `<mark>`; built from segments, never from HTML. */
function Highlighted({ segments }: { segments: Segment[] }) {
  let offset = 0;
  return (
    <>
      {segments.map((seg) => {
        const key = offset;
        offset += seg.text.length;
        return seg.match ? (
          <mark className="rounded-sm bg-ember-400/25 px-0.5 text-paper-100" key={key}>
            {seg.text}
          </mark>
        ) : (
          <span key={key}>{seg.text}</span>
        );
      })}
    </>
  );
}

/** The docs a new reader should open first, each with a glyph; the rest are listed below them. */
const FEATURED: Record<string, IconName> = {
  'product-overview': 'target',
  quickstart: 'arrowRight',
  README: 'docs',
};

function DocCard({ doc, featured = false }: { doc: DocMeta; featured?: boolean }) {
  return (
    <Link
      className={cn(
        'group flex h-full flex-col rounded-xl border transition-colors',
        featured
          ? 'border-ink-400/70 bg-ink-700 p-5 hover:border-ember-400/60'
          : 'border-ink-400/50 bg-ink-900/40 p-4 hover:border-ember-400/50 hover:bg-ink-700/40',
        FOCUS_RING
      )}
      href={`/docs/${doc.slug}`}
    >
      {featured && (
        <span
          aria-hidden="true"
          className="mb-4 flex h-9 w-9 items-center justify-center rounded-lg border border-ember-400/30 bg-ember-400/10 text-ember-300"
        >
          <Icon name={FEATURED[doc.slug] ?? 'docs'} size={17} />
        </span>
      )}
      <span className="flex items-start justify-between gap-3">
        <span
          className={cn(
            'font-semibold tracking-tight text-paper-100 transition-colors group-hover:text-ember-300',
            featured ? 'text-lg' : 'text-base'
          )}
        >
          {doc.title}
        </span>
        <Icon
          className="mt-1 text-paper-600 transition-transform group-hover:translate-x-0.5 group-hover:text-ember-300"
          name="arrowRight"
          size={14}
        />
      </span>
      {doc.description ? (
        <span className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-paper-500">
          {doc.description}
        </span>
      ) : null}
    </Link>
  );
}

/**
 * The docs index: the start-here docs as feature cards, then every doc in a
 * searchable grid. Search matches titles and one-line descriptions instantly;
 * once typing pauses, the server is also asked for the sections of the doc text
 * that match, and only those few results are downloaded. A newer keystroke
 * cancels the request in flight, and every keystroke starts a fresh attempt, so
 * a failure is retried by the next one.
 *
 * `search` and `debounceMs` are injectable so tests need no network or timers.
 */
export function DocsIndex({
  docs,
  search = fetchSearchResults,
  debounceMs = SEARCH_DEBOUNCE_MS,
}: {
  docs: DocMeta[];
  search?: (query: string, signal: AbortSignal) => Promise<SearchResult[]>;
  debounceMs?: number;
}) {
  const [query, setQuery] = useState('');
  const [text, setText] = useState<TextSearch>({ status: 'idle' });
  const q = query.trim().toLowerCase();
  // What the server is asked: the same text, cut to the length it considers.
  const request = query.trim().slice(0, MAX_QUERY_CHARS);

  useEffect(() => {
    if (!request) {
      setText({ status: 'idle' });
      return;
    }
    setText({ status: 'searching' });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      search(request, controller.signal).then(
        (results) => {
          if (!controller.signal.aborted) {
            setText({ query: request, results, status: 'ready' });
          }
        },
        () => {
          if (!controller.signal.aborted) {
            setText({ query: request, status: 'error' });
          }
        }
      );
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [request, search, debounceMs]);

  const featured = docs.filter((d) => d.slug in FEATURED);
  const rest = docs.filter((d) => !(d.slug in FEATURED));
  const matches = q
    ? docs.filter(
        (d) => d.title.toLowerCase().includes(q) || d.description.toLowerCase().includes(q)
      )
    : rest;
  // An answer is for the text it was asked about; until the new one arrives, the old is not shown.
  const answer = text.status === 'ready' || text.status === 'error' ? text : null;
  const current = q !== '' && answer?.query === request ? answer : null;
  const textResults = current?.status === 'ready' ? current.results : [];

  let status: string;
  let searching = false;
  if (!q) {
    status = plural(docs.length, 'doc');
  } else {
    const titles = `${matches.length} ${matches.length === 1 ? 'title match' : 'title matches'}`;
    if (current?.status === 'ready') {
      status = `${titles}, ${plural(textResults.length, 'section')} in the text`;
    } else if (current?.status === 'error') {
      status = `${titles}. Searching the doc text is unavailable; edit the search to try again.`;
    } else {
      status = `${titles}. Searching the doc text…`;
      searching = true;
    }
  }
  const settled = current !== null;
  const nothing = q !== '' && matches.length === 0 && textResults.length === 0 && settled;

  return (
    <div className="space-y-10">
      {!q && featured.length > 0 && (
        <section aria-labelledby="docs-start-here">
          <h2 className="mb-4 text-base font-semibold text-paper-100" id="docs-start-here">
            Start here
          </h2>
          <div className="grid gap-4 md:grid-cols-3">
            {featured.map((doc) => (
              <DocCard doc={doc} featured key={doc.slug} />
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="docs-all">
        <Toolbar
          end={
            // The live region speaks only once the search settles: while typing it is empty and
            // busy, and the visible "searching" text beside it is hidden from assistive tech.
            <span className="text-sm text-paper-500 tabular">
              <span aria-busy={searching} aria-live="polite" role="status">
                {searching ? '' : status}
              </span>
              {searching && <span aria-hidden="true">{status}</span>}
            </span>
          }
        >
          <h2 className="mr-3 text-base font-semibold text-paper-100" id="docs-all">
            {q ? 'Search results' : 'All docs'}
          </h2>
          <SearchInput
            label="Search docs"
            onChange={setQuery}
            placeholder="Search titles, summaries and text…"
            value={query}
          />
        </Toolbar>

        {nothing ? (
          <EmptyState
            bordered
            hint="Try a shorter word, or a feature name such as workflows, agents or MCP."
            icon="search"
            title={`No docs match "${query.trim()}"`}
          />
        ) : (
          <div className="space-y-8">
            {matches.length > 0 && (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {matches.map((doc) => (
                  <DocCard doc={doc} key={doc.slug} />
                ))}
              </div>
            )}
            {q && textResults.length > 0 && (
              <div>
                <h3 className="mb-3 text-sm font-semibold text-paper-200">In the text</h3>
                <ul className="space-y-2">
                  {textResults.map((r) => (
                    <li
                      className="rounded-lg border border-ink-400/50 bg-ink-900/40 p-3"
                      key={`${r.slug}#${r.anchor ?? ''}`}
                    >
                      <Link
                        className={cn(
                          'rounded-sm text-base font-medium text-paper-100 hover:text-ember-300',
                          FOCUS_RING
                        )}
                        href={docHref(r.slug, r.anchor ?? undefined)}
                      >
                        <Highlighted segments={r.title} />
                        {r.heading && (
                          <>
                            <span aria-hidden="true" className="px-1.5 text-paper-600">
                              ›
                            </span>
                            <span className="sr-only">, section </span>
                            <Highlighted segments={r.heading} />
                          </>
                        )}
                      </Link>
                      {r.snippet.length > 0 && (
                        <p className="mt-1 text-sm leading-relaxed text-paper-500">
                          <Highlighted segments={r.snippet} />
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
