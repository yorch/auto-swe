'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { docHref } from '@/components/ui/DocLink';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon, type IconName } from '@/components/ui/Icon';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { type SearchIndex, type Segment, searchDocs } from '@/lib/docSearch';
import type { DocMeta } from '@/lib/docs';
import { cn, FOCUS_RING, plural } from '@/lib/utils';

/** Where the prebuilt full-text index is served (`app/docs/search-index.json/route.ts`). */
export const SEARCH_INDEX_URL = '/docs/search-index.json';

/** Fetch the index. Rejects on a non-OK status or a body that is not an index (a login redirect, say). */
export async function fetchSearchIndex(): Promise<SearchIndex> {
  const res = await fetch(SEARCH_INDEX_URL, { credentials: 'same-origin' });
  if (!res.ok) {
    throw new Error(`search index request failed: ${res.status}`);
  }
  const body = (await res.json()) as Partial<SearchIndex>;
  if (!(Array.isArray(body.docs) && Array.isArray(body.sections))) {
    throw new Error('search index has an unexpected shape');
  }
  return body as SearchIndex;
}

type IndexState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; index: SearchIndex }
  | { status: 'error' };

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
          ? 'border-ink-400/70 bg-gradient-to-b from-ink-700 to-ink-900/80 p-5 hover:border-ember-400/60'
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
            featured ? 'text-base' : 'text-[15px]'
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
        <span className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-paper-500">
          {doc.description}
        </span>
      ) : null}
    </Link>
  );
}

/**
 * The docs index: the start-here docs as feature cards, then every doc in a
 * searchable grid. Search matches titles and one-line descriptions instantly;
 * the first focus or keystroke also fetches the full-text index, after which
 * the doc text is searched too, section by section.
 *
 * `loadIndex` is injectable so tests need no network.
 */
export function DocsIndex({
  docs,
  loadIndex = fetchSearchIndex,
}: {
  docs: DocMeta[];
  loadIndex?: () => Promise<SearchIndex>;
}) {
  const [query, setQuery] = useState('');
  const [indexState, setIndexState] = useState<IndexState>({ status: 'idle' });
  const started = useRef(false);
  const q = query.trim().toLowerCase();

  const ensureIndex = useCallback(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    setIndexState({ status: 'loading' });
    loadIndex().then(
      (index) => setIndexState({ index, status: 'ready' }),
      () => {
        // Allow the next focus or keystroke to try again; never retried in a loop.
        started.current = false;
        setIndexState({ status: 'error' });
      }
    );
  }, [loadIndex]);

  useEffect(() => {
    if (q) {
      ensureIndex();
    }
  }, [q, ensureIndex]);

  const featured = docs.filter((d) => d.slug in FEATURED);
  const rest = docs.filter((d) => !(d.slug in FEATURED));
  const matches = q
    ? docs.filter(
        (d) => d.title.toLowerCase().includes(q) || d.description.toLowerCase().includes(q)
      )
    : rest;
  const textResults = useMemo(
    () => (q && indexState.status === 'ready' ? searchDocs(indexState.index, q) : []),
    [q, indexState]
  );

  let status: string;
  if (!q) {
    status = plural(docs.length, 'doc');
  } else {
    const titles = `${matches.length} ${matches.length === 1 ? 'title match' : 'title matches'}`;
    if (indexState.status === 'ready') {
      status = `${titles}, ${plural(textResults.length, 'section')} in the text`;
    } else if (indexState.status === 'error') {
      status = `${titles}. Searching the doc text is unavailable.`;
    } else {
      status = `${titles}. Searching the doc text…`;
    }
  }
  const settled = indexState.status === 'ready' || indexState.status === 'error';
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
            <span aria-live="polite" className="text-[13px] text-paper-500 tabular" role="status">
              {status}
            </span>
          }
        >
          <h2 className="mr-3 text-base font-semibold text-paper-100" id="docs-all">
            {q ? 'Search results' : 'All docs'}
          </h2>
          {/* Focus moves into the input, so focusing it is what starts the index download. */}
          <div className="contents" onFocusCapture={ensureIndex}>
            <SearchInput
              label="Search docs"
              onChange={setQuery}
              placeholder="Search titles, summaries and text…"
              value={query}
            />
          </div>
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
                          'rounded-sm text-[14px] font-medium text-paper-100 hover:text-ember-300',
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
                        <p className="mt-1 text-[13px] leading-relaxed text-paper-500">
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
