import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DocToc } from '@/components/docs/DocToc';
import { Markdown } from '@/components/docs/Markdown';
import { ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { type DocMeta, getDoc, listDocs, servedDocSlugs } from '@/lib/docs';
import { extractToc } from '@/lib/docToc';
import { cn, FOCUS_RING } from '@/lib/utils';

type Params = { slug: string };

export const dynamic = 'force-static';
export const dynamicParams = false;

export async function generateStaticParams(): Promise<Params[]> {
  const docs = await listDocs();
  return docs.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const doc = await getDoc(slug);
  return {
    title: doc ? `${doc.title} · Docs` : 'Docs',
  };
}

export default async function DocPage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const doc = await getDoc(slug);
  if (!doc) {
    notFound();
  }
  const [served, docs] = await Promise.all([servedDocSlugs(), listDocs()]);
  const index = docs.findIndex((d) => d.slug === slug);
  const prev = index > 0 ? docs[index - 1] : undefined;
  const next = index >= 0 && index < docs.length - 1 ? docs[index + 1] : undefined;

  const toc = extractToc(doc.content);
  const hasToc = toc.length > 1;

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb">
        <ol className="flex min-w-0 items-center gap-1.5 text-[13px] text-paper-500">
          <li>
            <Link
              className={cn('rounded-sm transition-colors hover:text-paper-100', FOCUS_RING)}
              href="/docs"
            >
              Docs
            </Link>
          </li>
          <li aria-hidden="true">
            <Icon className="text-paper-600" name="chevronRight" size={13} />
          </li>
          <li aria-current="page" className="truncate text-paper-300">
            {doc.title}
          </li>
        </ol>
      </nav>

      <div
        className={cn(
          'grid gap-8',
          hasToc && 'lg:grid-cols-[minmax(0,1fr)_200px] xl:grid-cols-[minmax(0,1fr)_220px]'
        )}
      >
        <div className="min-w-0">
          {hasToc && (
            <details className="group mb-6 rounded-xl border border-ink-400/60 bg-ink-900/50 lg:hidden">
              <summary
                className={cn(
                  'flex cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-4 py-3 text-sm font-medium text-paper-200 [&::-webkit-details-marker]:hidden',
                  FOCUS_RING
                )}
              >
                On this page
                <Icon
                  className="text-paper-500 transition-transform group-open:rotate-180"
                  name="chevronDown"
                  size={15}
                />
              </summary>
              <div className="px-4 pb-4">
                <DocToc toc={toc} />
              </div>
            </details>
          )}

          <article className="max-w-3xl">
            <Markdown servedSlugs={served}>{doc.content}</Markdown>
          </article>

          {(prev || next) && (
            <nav
              aria-label="More docs"
              className="mt-14 grid max-w-3xl gap-3 border-t border-ink-600 pt-8 sm:grid-cols-2"
            >
              {prev ? <PagerLink direction="prev" doc={prev} /> : <span />}
              {next && <PagerLink direction="next" doc={next} />}
            </nav>
          )}
        </div>

        {hasToc && (
          <nav aria-label="On this page" className="hidden lg:block">
            <div className="sticky top-6 max-h-[calc(100dvh-3rem)] overflow-y-auto pb-6">
              <div className="mb-3 text-xs font-semibold text-paper-300">On this page</div>
              <DocToc toc={toc} />
              <div className="mt-6 border-t border-ink-600 pt-4">
                <ButtonLink className="-ml-2" href="/docs" size="sm" variant="ghost">
                  <Icon name="arrowLeft" size={14} />
                  All docs
                </ButtonLink>
              </div>
            </div>
          </nav>
        )}
      </div>
    </div>
  );
}

function PagerLink({ direction, doc }: { direction: 'prev' | 'next'; doc: DocMeta }) {
  const isNext = direction === 'next';
  return (
    <Link
      className={cn(
        'group flex flex-col gap-1 rounded-xl border border-ink-400/50 bg-ink-900/40 px-4 py-3 transition-colors hover:border-ember-400/50',
        isNext && 'sm:items-end sm:text-right',
        FOCUS_RING
      )}
      href={`/docs/${doc.slug}`}
    >
      <span className="flex items-center gap-1.5 text-xs text-paper-500">
        {!isNext && <Icon name="arrowLeft" size={12} />}
        {isNext ? 'Next' : 'Previous'}
        {isNext && <Icon name="arrowRight" size={12} />}
      </span>
      <span className="text-sm font-medium text-paper-100 group-hover:text-ember-300">
        {doc.title}
      </span>
    </Link>
  );
}
