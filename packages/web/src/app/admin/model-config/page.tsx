'use client';

import { useState } from 'react';
import { AuditLogTab } from '@/components/modelConfig/AuditLogTab';
import { CredentialsTab } from '@/components/modelConfig/CredentialsTab';
import { EmbeddingsTab } from '@/components/modelConfig/EmbeddingsTab';
import { MidRunWarning } from '@/components/modelConfig/MidRunWarning';
import { RolesTab } from '@/components/modelConfig/RolesTab';
import { TabBar } from '@/components/ui/TabBar';

type Tab = 'roles' | 'credentials' | 'embeddings' | 'audit';

const TABS: { id: Tab; label: string }[] = [
  { id: 'roles', label: 'Roles' },
  { id: 'credentials', label: 'Credentials' },
  { id: 'embeddings', label: 'Embeddings' },
  { id: 'audit', label: 'Audit log' },
];

export default function AdminModelConfigPage() {
  const [active, setActive] = useState<Tab>('roles');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Admin — Model configuration</h2>
        <p className="mt-1 text-sm text-paper-400">
          Per-role model picks, encrypted provider credentials, and the audit trail. Edits here
          apply system-wide. For per-team overrides, edit the team's settings page.
        </p>
      </div>
      <MidRunWarning />
      <TabBar active={active} onChange={setActive} tabs={TABS} />
      {active === 'roles' && <RolesTab />}
      {active === 'credentials' && <CredentialsTab />}
      {active === 'embeddings' && <EmbeddingsTab />}
      {active === 'audit' && <AuditLogTab />}
    </div>
  );
}
