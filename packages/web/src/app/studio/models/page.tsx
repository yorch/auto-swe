'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AuditLogTab } from '@/components/modelConfig/AuditLogTab';
import { CatalogTab } from '@/components/modelConfig/CatalogTab';
import { CredentialsTab } from '@/components/modelConfig/CredentialsTab';
import { EmbeddingsTab } from '@/components/modelConfig/EmbeddingsTab';
import { MidRunWarning } from '@/components/modelConfig/MidRunWarning';
import { PageHeader } from '@/components/ui/PageHeader';
import { TabBar } from '@/components/ui/TabBar';

type Tab = 'credentials' | 'catalog' | 'embeddings' | 'audit';

const TABS: { id: Tab; label: string }[] = [
  { id: 'credentials', label: 'Credentials' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'embeddings', label: 'Embeddings' },
  { id: 'audit', label: 'Audit log' },
];

export default function StudioModelConfigPage() {
  const [active, setActive] = useState<Tab>('credentials');

  return (
    <div className="space-y-8">
      <PageHeader
        chapter="§ Studio"
        subtitle={
          <>
            Encrypted provider credentials, the embedding model, and the audit trail. Per-role
            model, prompt, skill, and tool config now lives in the{' '}
            <Link className="text-ember-400 hover:text-ember-600" href="/studio/agents/library">
              Agent library
            </Link>
            .
          </>
        }
        title="Model configuration"
      />
      <MidRunWarning />
      <TabBar active={active} onChange={setActive} tabs={TABS} />
      {active === 'credentials' && <CredentialsTab />}
      {active === 'catalog' && <CatalogTab />}
      {active === 'embeddings' && <EmbeddingsTab />}
      {active === 'audit' && <AuditLogTab />}
    </div>
  );
}
