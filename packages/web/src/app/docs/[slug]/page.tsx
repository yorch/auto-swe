import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Markdown } from '@/components/docs/Markdown';
import { Card } from '@/components/ui/Card';
import { getDoc, listDocs, servedDocSlugs } from '@/lib/docs';

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
    title: doc ? `${doc.title} | Docs` : 'Docs',
  };
}

export default async function DocPage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const doc = await getDoc(slug);
  if (!doc) {
    notFound();
  }
  const served = await servedDocSlugs();

  return (
    <div className="max-w-4xl space-y-8">
      <nav className="flex items-baseline justify-between gap-4">
        <Link className="label-mono hover:text-paper-200" href="/docs">
          ← Docs
        </Link>
        <span className="font-mono text-xs text-paper-500">docs/{doc.slug}.md</span>
      </nav>
      <Card className="p-8">
        <Markdown servedSlugs={served}>{doc.content}</Markdown>
      </Card>
    </div>
  );
}
