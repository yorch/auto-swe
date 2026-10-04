'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { RegisterChannelModal } from '@/components/slackChannels/RegisterChannelModal';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { type SlackChannel, useSlackChannels } from '@/hooks/useSlackChannels';
import { useTeams } from '@/hooks/useTeams';
import { navLabel } from '@/lib/navigation';
import { formatCents, formatCost } from '@/lib/utils';

/** This month's spend against the cap: "$3.20 of $50.00", or "$3.20, no cap". */
function spendLabel(channel: SlackChannel): string {
  const spent = formatCost(channel.currentMonthUsage?.costUsdAccrued ?? 0);
  return channel.monthlyBudgetUsdCents == null
    ? `${spent}, no cap`
    : `${spent} of ${formatCents(channel.monthlyBudgetUsdCents)}`;
}

export default function GovernSlackChannelsPage() {
  const router = useRouter();
  const { data: channels, error: loadError, isError, isLoading } = useSlackChannels();
  const { data: teams } = useTeams();
  const [registerOpen, setRegisterOpen] = useState(false);
  const teamNames = new Map(teams?.map((t) => [t.id, t.name]));

  return (
    <div className="space-y-8">
      <PageHeader
        actions={
          <Button onClick={() => setRegisterOpen(true)} variant="primary">
            Register channel
          </Button>
        }
        chapter="§ Govern"
        subtitle="Slack channels the assistant responds in. Open a channel to change its settings, review what it remembers, and handle its open items."
        title={navLabel('/govern/slack-channels')}
      />

      <QueryBoundary
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="Slack channels"
      >
        <Card className="overflow-x-auto">
          <CardHeader>
            <CardTitle eyebrow="Channels">Registered channels</CardTitle>
          </CardHeader>
          <Table>
            <THead>
              <Th>Channel</Th>
              <Th>Team</Th>
              <Th>Status</Th>
              <Th align="right">Spend this month</Th>
            </THead>
            <tbody>
              {!channels || channels.length === 0 ? (
                <TableStatusRow colSpan={4}>
                  <EmptyState
                    hint="Choose “Register channel” to add one."
                    title="No Slack channels registered yet."
                  />
                </TableStatusRow>
              ) : (
                channels.map((ch) => (
                  <TRow hover key={ch.id}>
                    <Td className="px-4 py-3">
                      <Link
                        className="font-medium text-ember-400 hover:underline"
                        href={`/govern/slack-channels/${ch.id}`}
                      >
                        {ch.name ?? 'Unnamed channel'}
                      </Link>
                      {ch.isPrivate && (
                        <Badge className="ml-2" tone="amber" variant="text">
                          Private
                        </Badge>
                      )}
                    </Td>
                    <Td className="px-4 py-3 text-sm text-paper-300">
                      {teamNames.get(ch.teamId) ?? '—'}
                    </Td>
                    <Td className="px-4 py-3">
                      <Badge dot tone={ch.isActive ? 'moss' : 'muted'} variant="text">
                        {ch.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </Td>
                    <Td align="right" className="px-4 py-3 text-sm text-paper-400 tabular-nums">
                      {spendLabel(ch)}
                    </Td>
                  </TRow>
                ))
              )}
            </tbody>
          </Table>
        </Card>
      </QueryBoundary>

      <RegisterChannelModal
        onClose={() => setRegisterOpen(false)}
        onRegistered={(id) => router.push(`/govern/slack-channels/${id}`)}
        open={registerOpen}
      />
    </div>
  );
}
