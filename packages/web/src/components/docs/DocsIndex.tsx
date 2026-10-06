'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon, type IconName } from '@/components/ui/Icon';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import type { DocMeta } from '@/lib/docs';
import { cn, FOCUS_RING, plural } from '@/lib/utils';

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
 * searchable grid. Search matches the title and the one-line description.
 */
export function DocsIndex({ docs }: { docs: DocMeta[] }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const featured = docs.filter((d) => d.slug in FEATURED);
  const rest = docs.filter((d) => !(d.slug in FEATURED));
  const matches = q
    ? docs.filter(
        (d) => d.title.toLowerCase().includes(q) || d.description.toLowerCase().includes(q)
      )
    : rest;

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
            <span className="text-[13px] text-paper-500 tabular">
              {q
                ? `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`
                : plural(docs.length, 'doc')}
            </span>
          }
        >
          <h2 className="mr-3 text-base font-semibold text-paper-100" id="docs-all">
            {q ? 'Search results' : 'All docs'}
          </h2>
          <SearchInput
            label="Search docs"
            onChange={setQuery}
            placeholder="Search titles and summaries…"
            value={query}
          />
        </Toolbar>
        {matches.length === 0 ? (
          <EmptyState
            bordered
            hint="Try a shorter word, or a feature name such as workflows, agents or MCP."
            icon="search"
            title={`No docs match "${query.trim()}"`}
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {matches.map((doc) => (
              <DocCard doc={doc} key={doc.slug} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
