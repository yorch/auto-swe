import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Markdown } from '@/components/docs/Markdown';
import { Card } from '@/components/ui/Card';
import { getDoc, listDocs, servedDocSlugs } from '@/lib/docs';
import { extractToc } from '@/lib/docToc';

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
  const served = await servedDocSlugs();

  const toc = extractToc(doc.content);

  return (
    <div className="space-y-6">
      <nav aria-label="Docs" className="flex items-baseline justify-between gap-4">
        <Link className="label-mono hover:text-paper-200" href="/docs">
          ← Docs
        </Link>
      </nav>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_220px]">
        {toc.length > 1 && (
          <details className="rounded-xl border border-ink-400/60 bg-ink-900/50 px-4 py-3 lg:hidden">
            <summary className="cursor-pointer text-sm font-semibold text-paper-200">
              On this page
            </summary>
            <TocList toc={toc} />
          </details>
        )}
        <Card className="min-w-0 max-w-4xl p-5 md:p-8">
          <Markdown servedSlugs={served}>{doc.content}</Markdown>
        </Card>
        {toc.length > 1 && (
          <nav aria-label="On this page" className="hidden lg:block">
            <div className="sticky top-4">
              <div className="label-mono mb-3">On this page</div>
              <TocList toc={toc} />
            </div>
          </nav>
        )}
      </div>
    </div>
  );
}

function TocList({ toc }: { toc: ReturnType<typeof extractToc> }) {
  return (
    <ul className="mt-2 space-y-1.5 text-[13px]">
      {toc.map((entry) => (
        <li className={entry.level === 3 ? 'pl-3' : undefined} key={entry.id}>
          <a className="text-paper-400 hover:text-ember-400" href={`#${entry.id}`}>
            {entry.text}
          </a>
        </li>
      ))}
    </ul>
  );
}
