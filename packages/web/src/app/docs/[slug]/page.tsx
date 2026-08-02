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
    <div className="space-y-4 max-w-4xl">
      <nav className="text-xs text-paper-400">
        <Link className="hover:text-paper-100" href="/docs">
          Docs
        </Link>
        <span className="mx-2">/</span>
        <span className="font-mono">{doc.slug}.md</span>
      </nav>
      <Card className="p-8">
        <Markdown servedSlugs={served}>{doc.content}</Markdown>
      </Card>
    </div>
  );
}
