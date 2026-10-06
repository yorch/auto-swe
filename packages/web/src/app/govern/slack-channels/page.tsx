'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { RegisterChannelModal } from '@/components/slackChannels/RegisterChannelModal';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { type SlackChannel, useSlackChannels } from '@/hooks/useSlackChannels';
import { useTeams } from '@/hooks/useTeams';
import { navLabel } from '@/lib/navigation';
import { cn, FOCUS_RING, formatCents, formatTotalCost } from '@/lib/utils';

/** This month's spend against the cap: "$3.20 of $50.00", or "$3.20, no cap". */
function spendLabel(channel: SlackChannel): string {
  const spent = formatTotalCost(channel.currentMonthUsage?.costUsdAccrued ?? 0);
  return channel.monthlyBudgetUsdCents == null
    ? `${spent}, no cap`
    : `${spent} of ${formatCents(channel.monthlyBudgetUsdCents)}`;
}

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
          share >= 1 ? 'bg-brick-400' : share >= 0.8 ? 'bg-amber-400' : 'bg-ember-400'
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
        subtitle="Slack channels the assistant responds in. Open a channel to change its settings, review what it remembers, and handle its open items."
        title={navLabel('/govern/slack-channels')}
      />

      <Card>
        {isLoading ? (
          <SkeletonRows rows={4} />
        ) : (
          <QueryBoundary
            error={loadError}
            isError={isError}
            isFetching={isFetching}
            isLoading={false}
            label="Slack channels"
            onRetry={() => void refetch()}
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
                    <Table>
                      <THead>
                        <Th variant="plain">Channel</Th>
                        <Th variant="plain">Team</Th>
                        <Th variant="plain">Status</Th>
                        <Th align="right" variant="plain">
                          Spend this month
                        </Th>
                      </THead>
                      <tbody>
                        {shown.map((ch) => (
                          <TRow hover key={ch.id}>
                            <Td className="px-4 py-3">
                              <div className="flex flex-wrap items-center gap-2">
                                <Link
                                  className={cn(
                                    'rounded-sm font-medium text-paper-100 hover:text-ember-300',
                                    FOCUS_RING
                                  )}
                                  href={`/govern/slack-channels/${ch.id}`}
                                >
                                  {ch.name ? `#${ch.name}` : 'Unnamed channel'}
                                </Link>
                                {ch.isPrivate && (
                                  <Badge tone="amber" variant="outline">
                                    Private
                                  </Badge>
                                )}
                              </div>
                              <div className="mt-0.5 font-mono text-xs text-paper-500">
                                {ch.slackChannelId}
                              </div>
                            </Td>
                            <Td className="px-4 py-3 text-sm text-paper-300">
                              {teamNames.get(ch.teamId) ?? '—'}
                            </Td>
                            <Td className="px-4 py-3">
                              <Badge dot tone={ch.isActive ? 'moss' : 'muted'} variant="text">
                                {ch.isActive ? 'Active' : 'Inactive'}
                              </Badge>
                            </Td>
                            <Td
                              align="right"
                              className="px-4 py-3 text-[13px] text-paper-300 tabular-nums"
                            >
                              {spendLabel(ch)}
                              <SpendMeter channel={ch} />
                            </Td>
                          </TRow>
                        ))}
                      </tbody>
                    </Table>
                  </div>
                )}
              </>
            )}
          </QueryBoundary>
        )}
      </Card>

      <RegisterChannelModal
        onClose={() => setRegisterOpen(false)}
        onRegistered={(id) => router.push(`/govern/slack-channels/${id}`)}
        open={registerOpen}
      />
    </div>
  );
}
