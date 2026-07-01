'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AuditLogTab } from '@/components/modelConfig/AuditLogTab';
import { CredentialsTab } from '@/components/modelConfig/CredentialsTab';
import { EmbeddingsTab } from '@/components/modelConfig/EmbeddingsTab';
import { MidRunWarning } from '@/components/modelConfig/MidRunWarning';
import { PageHeader } from '@/components/ui/PageHeader';
import { TabBar } from '@/components/ui/TabBar';

type Tab = 'credentials' | 'embeddings' | 'audit';

const TABS: { id: Tab; label: string }[] = [
  { id: 'credentials', label: 'Credentials' },
  { id: 'embeddings', label: 'Embeddings' },
  { id: 'audit', label: 'Audit log' },
];

export default function AdminModelConfigPage() {
  const [active, setActive] = useState<Tab>('credentials');

  return (
    <div className="space-y-6">
      <div>
        <PageHeader className="mb-3" title="Admin — Model configuration" />
        <p className="max-w-2xl text-sm leading-relaxed text-paper-400">
          Encrypted provider credentials, the embedding model, and the audit trail. Per-role model,
          prompt, skill, and tool config now lives in the{' '}
          <Link className="text-ember-400 hover:text-ember-300" href="/admin/agents/library">
            Agent library
          </Link>
          .
        </p>
      </div>
      <MidRunWarning />
      <TabBar active={active} onChange={setActive} tabs={TABS} />
      {active === 'credentials' && <CredentialsTab />}
      {active === 'embeddings' && <EmbeddingsTab />}
      {active === 'audit' && <AuditLogTab />}
    </div>
  );
}
