import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { listDocs } from '@/lib/docs';

export const dynamic = 'force-static';

export const metadata = {
  title: 'Docs | auto-swe',
};

export default async function DocsIndexPage() {
  const docs = await listDocs();

  return (
    <div className="space-y-8">
      <PageHeader
        chapter="§ Docs"
        subtitle="Architecture, implementation, and design references for auto-swe."
        title="Docs"
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {docs.map((doc) => (
          <Link
            className="group block rounded-[14px] focus:outline-none focus-visible:ring-2 focus-visible:ring-ember-400"
            href={`/docs/${doc.slug}`}
            key={doc.slug}
          >
            <Card className="h-full p-5 group-hover:border-ember-400/60" variant="inset">
              <div className="label-mono mb-1">docs/{doc.slug}.md</div>
              <h3 className="mb-2 text-base font-semibold text-paper-100 group-hover:text-ember-400">
                {doc.title} →
              </h3>
              {doc.description ? (
                <p className="text-xs leading-relaxed text-paper-500">{doc.description}</p>
              ) : null}
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
