'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuditLogTab } from '@/components/integrations/AuditLogTab';
import { FigmaTab } from '@/components/integrations/FigmaTab';
import { GitHubTab } from '@/components/integrations/GitHubTab';
import { IssueTrackerTab } from '@/components/integrations/IssueTrackerTab';
import { KnowledgeBaseTab } from '@/components/integrations/KnowledgeBaseTab';
import { SlackTab } from '@/components/integrations/SlackTab';
import { SourceBadge } from '@/components/integrations/SourceBadge';
import { PageHeader } from '@/components/ui/PageHeader';
import { TabBar } from '@/components/ui/TabBar';

type Tab = 'github' | 'slack' | 'tracker' | 'knowledge-base' | 'figma' | 'audit-log';

const TABS: { id: Tab; label: string }[] = [
  { id: 'github', label: 'GitHub' },
  { id: 'slack', label: 'Slack' },
  { id: 'tracker', label: 'Issue Tracker' },
  { id: 'knowledge-base', label: 'Knowledge Base' },
  { id: 'figma', label: 'Figma' },
  { id: 'audit-log', label: 'Audit log' },
];

function isTab(value: string | null): value is Tab {
  return TABS.some((t) => t.id === value);
}

export default function StudioIntegrationsPage() {
  // useSearchParams() needs a Suspense boundary above it for the page to stay
  // statically prerenderable.
  return (
    <Suspense fallback={null}>
      <StudioIntegrationsPageInner />
    </Suspense>
  );
}

function StudioIntegrationsPageInner() {
  const searchParams = useSearchParams();
  // `?tab=` picks the initial tab (the Slack install callback lands on
  // `?tab=slack&slack_installed=<teamId>`); switching afterwards is local state.
  const requestedTab = searchParams.get('tab');
  const [active, setActive] = useState<Tab>(isTab(requestedTab) ? requestedTab : 'github');
  const installedSlackTeamId = searchParams.get('slack_installed');

  return (
    <div className="space-y-8">
      <PageHeader
        chapter="§ Studio"
        subtitle={
          <>
            Configure GitHub, Slack, issue tracker, knowledge base, and Figma credentials. Masked
            fields show only the last four characters — enter a new value to rotate. An{' '}
            <SourceBadge source="env" /> badge means the value is currently read from an environment
            variable. Sign-in providers (Google, Okta, GitHub OAuth) and artifact storage are set
            through environment variables only; see docs/configuration.md.
          </>
        }
        title="Integrations"
      />
      <TabBar active={active} onChange={setActive} tabs={TABS} />
      {active === 'github' && <GitHubTab />}
      {active === 'slack' && <SlackTab installedTeamId={installedSlackTeamId} />}
      {active === 'tracker' && <IssueTrackerTab />}
      {active === 'knowledge-base' && <KnowledgeBaseTab />}
      {active === 'figma' && <FigmaTab />}
      {active === 'audit-log' && <AuditLogTab />}
    </div>
  );
}
