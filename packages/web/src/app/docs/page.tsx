import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { listDocs } from '@/lib/docs';

export const dynamic = 'force-static';

export const metadata = {
  title: 'Docs | auto-swe',
};

export default async function DocsIndexPage() {
  const docs = await listDocs();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Documentation</h2>
        <p className="text-sm text-paper-400 mt-1">
          Architecture, implementation, and design references for auto-swe.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {docs.map((doc) => (
          <Link
            className="block group focus:outline-none focus:ring-2 focus:ring-ember-400 rounded-lg"
            href={`/docs/${doc.slug}`}
            key={doc.slug}
          >
            <Card className="h-full transition-shadow group-hover:shadow-md">
              <h3 className="text-base font-semibold group-hover:text-ember-400">
                {doc.title}
              </h3>
              {doc.description ? (
                <p className="text-sm text-paper-400 mt-2">{doc.description}</p>
              ) : null}
              <p className="text-xs text-paper-400 mt-3 font-mono">
                docs/{doc.slug}.md
              </p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
