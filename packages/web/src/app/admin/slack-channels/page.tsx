'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { RegisterChannelModal } from '@/components/slackChannels/RegisterChannelModal';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { useDataTableSort } from '@/hooks/useDataTableSort';
import { type SlackChannel, useSlackChannels } from '@/hooks/useSlackChannels';
import { useTeams } from '@/hooks/useTeams';
import { navLabel } from '@/lib/navigation';
import { cn, formatCents, formatTotalCost } from '@/lib/utils';

/** This month's spend against the cap: "$3.20 of $50.00", or "$3.20, no cap". */
function spendLabel(channel: SlackChannel): string {
  const spent = formatTotalCost(channel.currentMonthUsage?.costUsdAccrued ?? 0);
  return channel.monthlyBudgetUsdCents == null
    ? `${spent}, no cap`
    : `${spent} of ${formatCents(channel.monthlyBudgetUsdCents)}`;
}

const CHANNEL_SORT_KEYS = {
  name: (ch: SlackChannel) => ch.name?.toLowerCase() ?? null,
  spend: (ch: SlackChannel) => ch.currentMonthUsage?.costUsdAccrued ?? 0,
};

/**
 * This month's spend as a share of the cap, as a thin meter. The fill carries
 * severity (accent, then warning from 80%, then failure at the cap); the label
 * beside it carries the numbers, so the state never rests on colour alone.
 */
function SpendMeter({ channel }: { channel: SlackChannel }) {
  const cap = channel.monthlyBudgetUsdCents;
  if (cap == null || cap <= 0) {
    return null;
  }
  const spentCents = (channel.currentMonthUsage?.costUsdAccrued ?? 0) * 100;
  const share = spentCents / cap;
  return (
    <div
      aria-hidden
      className="mt-1.5 ml-auto h-1 w-28 overflow-hidden rounded-full bg-ink-400"
      title={`${Math.round(share * 100)}% of this month's cap`}
    >
      <div
        className={cn(
          'h-full rounded-full',
          share >= 1 ? 'bg-danger-400' : share >= 0.8 ? 'bg-warning-400' : 'bg-paper-600'
        )}
        style={{ width: `${Math.min(100, Math.max(share * 100, share > 0 ? 4 : 0))}%` }}
      />
    </div>
  );
}

export default function GovernSlackChannelsPage() {
  const router = useRouter();
  const {
    data: channels,
    error: loadError,
    isError,
    isFetching,
    isLoading,
    refetch,
  } = useSlackChannels();
  const { data: teams } = useTeams();
  const [registerOpen, setRegisterOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { onSortChange, sort, sortRows } = useDataTableSort<SlackChannel>(CHANNEL_SORT_KEYS);
  const teamNames = new Map(teams?.map((t) => [t.id, t.name]));

  const needle = query.trim().toLowerCase();
  const shown = (channels ?? []).filter(
    (ch) =>
      !needle ||
      [ch.name ?? '', ch.slackChannelId, teamNames.get(ch.teamId) ?? ''].some((text) =>
        text.toLowerCase().includes(needle)
      )
  );

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button onClick={() => setRegisterOpen(true)} variant="primary">
            <Icon name="plus" size={14} />
            Register channel
          </Button>
        }
        help={
          <p>
            Open a channel to change its settings, review what it remembers, and handle its open
            items.
          </p>
        }
        subtitle="Slack channels the assistant responds in."
        title={navLabel('/admin/slack-channels')}
      />

      <Card>
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="Slack channels"
          onRetry={() => void refetch()}
          rows={4}
        >
          {!channels || channels.length === 0 ? (
            <EmptyState
              action={
                <Button onClick={() => setRegisterOpen(true)} size="sm">
                  Register channel
                </Button>
              }
              hint="Register a channel to let the assistant answer, follow up and remember context there. Each channel belongs to a team and can carry its own spend cap."
              icon="chat"
              title="No Slack channels registered yet"
            />
          ) : (
            <>
              <Toolbar
                end={
                  <span className="text-xs text-paper-500 tabular-nums">
                    {needle ? `${shown.length} of ${channels.length}` : channels.length} channel
                    {channels.length === 1 ? '' : 's'}
                  </span>
                }
              >
                <SearchInput
                  label="Search channels"
                  onChange={setQuery}
                  placeholder="Search channel or team…"
                  value={query}
                />
              </Toolbar>
              {shown.length === 0 ? (
                <EmptyState
                  action={
                    <Button onClick={() => setQuery('')} size="sm">
                      Clear search
                    </Button>
                  }
                  icon="search"
                  title="No channels match your search"
                />
              ) : (
                <div className="-mx-4">
                  <DataTable
                    className="max-sm:px-4"
                    columns={[
                      {
                        cell: (ch) => (ch.name ? `#${ch.name}` : 'Unnamed channel'),
                        header: 'Channel',
                        id: 'name',
                        primary: true,
                        secondary: (ch) => (
                          <div className="flex flex-wrap items-center gap-2">
                            {ch.isPrivate && (
                              <Badge tone="warning" variant="outline">
                                Private
                              </Badge>
                            )}
                            <span className="font-mono">{ch.slackChannelId}</span>
                          </div>
                        ),
                        sortable: true,
                      },
                      {
                        cell: (ch) => (
                          <span className="text-sm text-paper-300">
                            {teamNames.get(ch.teamId) ?? '—'}
                          </span>
                        ),
                        header: 'Team',
                        id: 'team',
                      },
                      {
                        cell: (ch) => (
                          <Badge dot tone={ch.isActive ? 'success' : 'muted'} variant="text">
                            {ch.isActive ? 'Active' : 'Inactive'}
                          </Badge>
                        ),
                        header: 'Status',
                        id: 'status',
                      },
                      {
                        align: 'right',
                        cell: (ch) => (
                          <span className="text-sm text-paper-300 tabular-nums">
                            {spendLabel(ch)}
                            <SpendMeter channel={ch} />
                          </span>
                        ),
                        header: 'Spend this month',
                        id: 'spend',
                        sortable: true,
                      },
                    ]}
                    getRowId={(ch) => ch.id}
                    onSortChange={onSortChange}
                    rowHref={(ch) => `/admin/slack-channels/${ch.id}`}
                    rows={sortRows(shown)}
                    sort={sort}
                  />
                </div>
              )}
            </>
          )}
        </QueryBoundary>
      </Card>

      <RegisterChannelModal
        onClose={() => setRegisterOpen(false)}
        onRegistered={(id) => router.push(`/admin/slack-channels/${id}`)}
        open={registerOpen}
      />
    </div>
  );
}
