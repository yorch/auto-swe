'use client';

import { Suspense } from 'react';
import { ConfigAuditLogTab } from '@/components/audit/ConfigAuditLogTab';
import { FigmaTab } from '@/components/integrations/FigmaTab';
import { GitHubTab } from '@/components/integrations/GitHubTab';
import { IssueTrackerTab } from '@/components/integrations/IssueTrackerTab';
import { KnowledgeBaseTab } from '@/components/integrations/KnowledgeBaseTab';
import { SlackTab } from '@/components/integrations/SlackTab';
import { SourceBadge } from '@/components/integrations/SourceBadge';
import { SetupBanner } from '@/components/setup/SetupReadiness';
import { PageHeader } from '@/components/ui/PageHeader';
import { TabBar, tabPanelProps } from '@/components/ui/TabBar';
import { useUrlFilters } from '@/hooks/useUrlFilters';

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
  // `?tab=` is the active tab (the Slack install callback lands on
  // `?tab=slack&slack_installed=<teamId>`), so every tab is linkable.
  const { params, update } = useUrlFilters();
  const requestedTab = params.get('tab');
  const active: Tab = isTab(requestedTab) ? requestedTab : 'github';
  const installedSlackTeamId = params.get('slack_installed');

  return (
    <div className="space-y-8">
      <PageHeader
        subtitle={
          <>
            Configure GitHub, Slack, issue tracker, knowledge base, and Figma credentials. Masked
            fields show only the last four characters — enter a new value to rotate. An{' '}
            <SourceBadge source="env" /> badge means the value is currently read from an environment
            variable. Sign-in providers (Google, Okta, GitHub OAuth) and artifact storage are set
            through environment variables only, not here.
          </>
        }
        title="Integrations"
      />
      <SetupBanner items={['github']} />
      <TabBar
        active={active}
        idPrefix="integrations"
        onChange={(tab) => update({ slack_installed: null, tab: tab === 'github' ? null : tab })}
        tabs={TABS}
      />
      <div {...tabPanelProps('integrations', active)}>
        {active === 'github' && <GitHubTab />}
        {active === 'slack' && <SlackTab installedTeamId={installedSlackTeamId} />}
        {active === 'tracker' && <IssueTrackerTab />}
        {active === 'knowledge-base' && <KnowledgeBaseTab />}
        {active === 'figma' && <FigmaTab />}
        {active === 'audit-log' && <ConfigAuditLogTab initialGroup="integrations" />}
      </div>
    </div>
  );
}
