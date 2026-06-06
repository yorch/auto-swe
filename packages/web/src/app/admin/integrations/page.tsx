'use client';

import { useState } from 'react';
import { AuditLogTab } from '@/components/integrations/AuditLogTab';
import { GitHubTab } from '@/components/integrations/GitHubTab';
import { OAuthTab } from '@/components/integrations/OAuthTab';
import { SlackTab } from '@/components/integrations/SlackTab';
import { StorageTab } from '@/components/integrations/StorageTab';
import { TabBar } from '@/components/ui/TabBar';

type Tab = 'github' | 'slack' | 'storage' | 'oauth' | 'audit-log';

const TABS: { id: Tab; label: string }[] = [
  { id: 'github', label: 'GitHub' },
  { id: 'slack', label: 'Slack' },
  { id: 'storage', label: 'Storage' },
  { id: 'oauth', label: 'OAuth' },
  { id: 'audit-log', label: 'Audit log' },
];

export default function AdminIntegrationsPage() {
  const [active, setActive] = useState<Tab>('github');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Admin — Integrations</h2>
        <p className="mt-1 text-sm text-paper-400">
          Configure GitHub, Slack, storage backend, and OAuth provider credentials. Masked fields
          show only the last four characters — enter a new value to rotate. An{' '}
          <span className="rounded-sm bg-amber-900/40 px-1 font-mono text-[10px] text-amber-400">
            env
          </span>{' '}
          badge means the value is currently read from an environment variable.
        </p>
      </div>
      <TabBar active={active} onChange={setActive} tabs={TABS} />
      {active === 'github' && <GitHubTab />}
      {active === 'slack' && <SlackTab />}
      {active === 'storage' && <StorageTab />}
      {active === 'oauth' && <OAuthTab />}
      {active === 'audit-log' && <AuditLogTab />}
    </div>
  );
}
