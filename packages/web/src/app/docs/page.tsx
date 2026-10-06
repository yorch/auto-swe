import { DocsIndex } from '@/components/docs/DocsIndex';
import { PageHeader } from '@/components/ui/PageHeader';
import { listDocs } from '@/lib/docs';

export const dynamic = 'force-static';

export const metadata = {
  title: 'Docs',
};

export default async function DocsIndexPage() {
  const docs = await listDocs();

  return (
    <div>
      <PageHeader
        subtitle="How auto-swe works and how to run it: concepts, setup guides, and references for every part of the platform."
        title="Docs"
      />
      <DocsIndex docs={docs} />
    </div>
  );
}
