'use client';

import { useState } from 'react';
import { AuditLogTab } from '@/components/integrations/AuditLogTab';
import { FigmaTab } from '@/components/integrations/FigmaTab';
import { GitHubTab } from '@/components/integrations/GitHubTab';
import { IssueTrackerTab } from '@/components/integrations/IssueTrackerTab';
import { KnowledgeBaseTab } from '@/components/integrations/KnowledgeBaseTab';
import { OAuthTab } from '@/components/integrations/OAuthTab';
import { SlackTab } from '@/components/integrations/SlackTab';
import { StorageTab } from '@/components/integrations/StorageTab';
import { PageHeader } from '@/components/ui/PageHeader';
import { TabBar } from '@/components/ui/TabBar';

type Tab =
  | 'github'
  | 'slack'
  | 'storage'
  | 'tracker'
  | 'knowledge-base'
  | 'figma'
  | 'oauth'
  | 'audit-log';

const TABS: { id: Tab; label: string }[] = [
  { id: 'github', label: 'GitHub' },
  { id: 'slack', label: 'Slack' },
  { id: 'storage', label: 'Storage' },
  { id: 'tracker', label: 'Issue Tracker' },
  { id: 'knowledge-base', label: 'Knowledge Base' },
  { id: 'figma', label: 'Figma' },
  { id: 'oauth', label: 'OAuth' },
  { id: 'audit-log', label: 'Audit log' },
];

export default function StudioIntegrationsPage() {
  const [active, setActive] = useState<Tab>('github');

  return (
    <div className="space-y-6">
      <PageHeader
        subtitle={
          <>
            Configure GitHub, Slack, storage backend, issue tracker, and OAuth provider credentials.
            Masked fields show only the last four characters — enter a new value to rotate. An{' '}
            <span className="rounded bg-amber-900/40 px-1 font-mono text-[10px] text-amber-400">
              env
            </span>{' '}
            badge means the value is currently read from an environment variable.
          </>
        }
        title="Admin — Integrations"
      />
      <TabBar active={active} onChange={setActive} tabs={TABS} />
      {active === 'github' && <GitHubTab />}
      {active === 'slack' && <SlackTab />}
      {active === 'storage' && <StorageTab />}
      {active === 'tracker' && <IssueTrackerTab />}
      {active === 'knowledge-base' && <KnowledgeBaseTab />}
      {active === 'figma' && <FigmaTab />}
      {active === 'oauth' && <OAuthTab />}
      {active === 'audit-log' && <AuditLogTab />}
    </div>
  );
}
