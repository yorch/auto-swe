'use client';

import Link from 'next/link';
import { Suspense } from 'react';
import { AuditLogTab } from '@/components/modelConfig/AuditLogTab';
import { CatalogTab } from '@/components/modelConfig/CatalogTab';
import { CredentialsTab } from '@/components/modelConfig/CredentialsTab';
import { EmbeddingsTab } from '@/components/modelConfig/EmbeddingsTab';
import { MidRunWarning } from '@/components/modelConfig/MidRunWarning';
import { SetupBanner } from '@/components/setup/SetupReadiness';
import { PageHeader } from '@/components/ui/PageHeader';
import { TabBar } from '@/components/ui/TabBar';
import { useUrlParams } from '@/hooks/useUrlParams';

type Tab = 'credentials' | 'catalog' | 'embeddings' | 'audit';

const TABS: { id: Tab; label: string }[] = [
  { id: 'credentials', label: 'Credentials' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'embeddings', label: 'Embeddings' },
  { id: 'audit', label: 'Audit log' },
];

function isTab(value: string | null): value is Tab {
  return TABS.some((t) => t.id === value);
}

export default function StudioModelConfigPage() {
  // useSearchParams() needs a Suspense boundary above it for the page to stay
  // statically prerenderable.
  return (
    <Suspense fallback={null}>
      <StudioModelConfigPageInner />
    </Suspense>
  );
}

function StudioModelConfigPageInner() {
  // The active tab lives in `?tab=` so a tab can be linked to (the setup checklist does).
  const { params, update } = useUrlParams();
  const requested = params.get('tab');
  const active: Tab = isTab(requested) ? requested : 'credentials';

  return (
    <div className="space-y-8">
      <PageHeader
        chapter="§ Studio"
        subtitle={
          <>
            Encrypted provider credentials, the embedding model, and the audit trail. Each agent's
            model, prompt, skills, and tools are set in the{' '}
            <Link className="text-ember-400 hover:text-ember-600" href="/studio/agents/library">
              Agent library
            </Link>
            .
          </>
        }
        title="Model configuration"
      />
      <MidRunWarning />
      <SetupBanner items={['credentials', 'embeddings']} />
      <TabBar
        active={active}
        onChange={(tab) => update({ tab: tab === 'credentials' ? null : tab })}
        tabs={TABS}
      />
      {active === 'credentials' && <CredentialsTab />}
      {active === 'catalog' && <CatalogTab />}
      {active === 'embeddings' && <EmbeddingsTab />}
      {active === 'audit' && <AuditLogTab />}
    </div>
  );
}
