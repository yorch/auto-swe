'use client';

import Link from 'next/link';
import { use } from 'react';
import { ChannelActivityTab } from '@/components/slackChannels/ChannelActivityTab';
import { ChannelMemoryTab } from '@/components/slackChannels/ChannelMemoryTab';
import { ChannelOpenItemsTab } from '@/components/slackChannels/ChannelOpenItemsTab';
import { ChannelSettingsTab } from '@/components/slackChannels/ChannelSettingsTab';
import { Badge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { TabBar, tabPanelProps } from '@/components/ui/TabBar';
import { useSlackChannel } from '@/hooks/useSlackChannels';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { validateRouteParam } from '@/lib/routeParams';

type Tab = 'settings' | 'memory' | 'open-items' | 'activity';

const TABS: { id: Tab; label: string }[] = [
  { id: 'settings', label: 'Settings' },
  { id: 'memory', label: 'Memory' },
  { id: 'open-items', label: 'Open items' },
  { id: 'activity', label: 'Activity' },
];

export default function SlackChannelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = use(params);
  const id = validateRouteParam(rawId);
  // The single-channel read, not the list: it carries the memory count the delete confirm
  // quotes and a stale list entry cannot hide a channel that exists.
  const { data: channel, error, isError, isFetching, isLoading, refetch } = useSlackChannel(id);
  // The tab lives in the URL so a view can be linked to and survives a reload.
  const { params: query, update } = useUrlFilters();
  const rawTab = query.get('tab');
  const tab: Tab = TABS.some((t) => t.id === rawTab) ? (rawTab as Tab) : 'settings';
  const setTab = (next: Tab) => update({ tab: next === 'settings' ? null : next });

  return (
    <div className="space-y-6">
      <Link className="label-mono hover:text-paper-200" href="/govern/slack-channels">
        ← Slack channels
      </Link>
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="Slack channel"
        onRetry={() => void refetch()}
      >
        {!channel ? (
          <EmptyState
            action={<ButtonLink href="/govern/slack-channels">Back to Slack channels</ButtonLink>}
            title="Slack channel not found"
          />
        ) : (
          <>
            <PageHeader
              actions={
                <Badge dot tone={channel.isActive ? 'moss' : 'muted'} variant="text">
                  {channel.isActive ? 'Active' : 'Inactive'}
                </Badge>
              }
              className="mb-4"
              subtitle={`${channel.workspace.name ? `${channel.workspace.name} · ` : ''}Each channel belongs to a team and can set its own agent, schedules and monthly spend cap.`}
              title={channel.name ?? 'Unnamed channel'}
            />
            <TabBar
              active={tab}
              ariaLabel="Channel sections"
              idPrefix="slack-channel"
              onChange={setTab}
              tabs={TABS}
            />
            <div className="pt-2">
              {/* Stays mounted while another tab is open, so switching tabs never discards
                  edits that have not been saved yet. */}
              <div hidden={tab !== 'settings'} {...tabPanelProps('slack-channel', 'settings')}>
                <ChannelSettingsTab channel={channel} key={channel.id} />
              </div>
              {tab !== 'settings' && (
                <div {...tabPanelProps('slack-channel', tab)}>
                  {tab === 'memory' && <ChannelMemoryTab channel={channel} />}
                  {tab === 'open-items' && <ChannelOpenItemsTab channel={channel} />}
                  {tab === 'activity' && <ChannelActivityTab channel={channel} />}
                </div>
              )}
            </div>
          </>
        )}
      </QueryBoundary>
    </div>
  );
}
