'use client';

import { Suspense, useState } from 'react';
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

  // A form tab stays mounted once opened (hidden while another is active), so its unsaved edits
  // survive however the tab changes: the tab bar or the browser Back button, which the page
  // cannot intercept. A link to another page still asks through the unsaved-changes guard that
  // each form registers while it is dirty.
  const [opened, setOpened] = useState<ReadonlySet<Tab>>(() => new Set([active]));
  if (!opened.has(active)) {
    setOpened(new Set([...opened, active]));
  }
  const panel = (tab: Tab, content: React.ReactNode) =>
    opened.has(tab) || active === tab ? (
      <div hidden={active !== tab} {...tabPanelProps('integrations', tab)}>
        {content}
      </div>
    ) : null;

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
      <SetupBanner
        here={`/studio/integrations?tab=${active}`}
        inPage={{
          label: 'Enter a token below',
          onClick: () => {
            const field = document.getElementById('gh-token');
            field?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            field?.focus();
          },
        }}
        items={['github']}
      />
      <TabBar
        active={active}
        idPrefix="integrations"
        onChange={(tab) => update({ slack_installed: null, tab: tab === 'github' ? null : tab })}
        tabs={TABS}
      />
      {panel('github', <GitHubTab />)}
      {panel('slack', <SlackTab installedTeamId={installedSlackTeamId} />)}
      {panel('tracker', <IssueTrackerTab />)}
      {panel('knowledge-base', <KnowledgeBaseTab />)}
      {panel('figma', <FigmaTab />)}
      {active === 'audit-log' && (
        <div {...tabPanelProps('integrations', 'audit-log')}>
          <ConfigAuditLogTab initialGroup="integrations" />
        </div>
      )}
    </div>
  );
}
