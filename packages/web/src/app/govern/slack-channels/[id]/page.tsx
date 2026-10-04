'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { ChannelActivityTab } from '@/components/slackChannels/ChannelActivityTab';
import { ChannelMemoryTab } from '@/components/slackChannels/ChannelMemoryTab';
import { ChannelOpenItemsTab } from '@/components/slackChannels/ChannelOpenItemsTab';
import { ChannelSettingsTab } from '@/components/slackChannels/ChannelSettingsTab';
import { Badge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { TabBar } from '@/components/ui/TabBar';
import { useSlackChannels } from '@/hooks/useSlackChannels';
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
  const { data: channels, error, isError, isLoading } = useSlackChannels();
  const [tab, setTab] = useState<Tab>('settings');
  const channel = channels?.find((c) => c.id === id);

  return (
    <div className="space-y-6">
      <Link className="label-mono hover:text-paper-200" href="/govern/slack-channels">
        ← Slack channels
      </Link>
      <QueryBoundary error={error} isError={isError} isLoading={isLoading} label="Slack channel">
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
              chapter="§ Govern"
              className="mb-4"
              subtitle={`${channel.workspace.name ? `${channel.workspace.name} · ` : ''}Each channel belongs to a team and can set its own agent, schedules and monthly spend cap.`}
              title={channel.name ?? 'Unnamed channel'}
            />
            <TabBar active={tab} onChange={setTab} tabs={TABS} />
            <div className="pt-2">
              {tab === 'settings' && <ChannelSettingsTab channel={channel} key={channel.id} />}
              {tab === 'memory' && <ChannelMemoryTab channel={channel} />}
              {tab === 'open-items' && <ChannelOpenItemsTab channel={channel} />}
              {tab === 'activity' && <ChannelActivityTab channel={channel} />}
            </div>
          </>
        )}
      </QueryBoundary>
    </div>
  );
}
