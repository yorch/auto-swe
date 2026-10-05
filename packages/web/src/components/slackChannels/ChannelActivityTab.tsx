'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import {
  type ChannelAuditKind,
  type SlackChannel,
  useChannelAudit,
} from '@/hooks/useSlackChannels';
import { useUsers } from '@/hooks/useUsers';
import { emailsBySlackId, slackUserLabel } from '@/lib/slackUserLabel';
import { formatCost, formatRelativeTime, formatTokens } from '@/lib/utils';

const KIND_LABELS: Record<ChannelAuditKind | 'all', string> = {
  all: 'All',
  ambient: 'Digests',
  mention: 'Mentions',
  reactive: 'Reactive',
};

const KIND_TONES: Record<ChannelAuditKind, BadgeTone> = {
  ambient: 'moss',
  mention: 'dust',
  reactive: 'amber',
};

/** Who triggered the assistant in this channel, what they asked, and what it cost. */
export function ChannelActivityTab({ channel }: { channel: SlackChannel }) {
  const [kindFilter, setKindFilter] = useState<ChannelAuditKind | 'all'>('all');
  const {
    data: entries,
    error: loadError,
    isError,
    isFetching,
    refetch,
    isLoading,
  } = useChannelAudit(channel.id, kindFilter);
  const { data: users } = useUsers();
  const names = emailsBySlackId(users);

  return (
    <div className="space-y-4">
      <p className="text-sm text-paper-400">
        Who triggered the assistant in this channel, what they asked, and what it did. Each entry
        links to the full run.
      </p>
      <SegmentedControl
        ariaLabel="Filter activity by trigger"
        onChange={setKindFilter}
        options={(['all', 'mention', 'ambient', 'reactive'] as const).map((k) => ({
          label: KIND_LABELS[k],
          value: k,
        }))}
        value={kindFilter}
      />

      {isLoading || isError ? (
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="activity"
          onRetry={() => void refetch()}
        />
      ) : !entries || entries.length === 0 ? (
        <EmptyState
          className="py-4"
          title={`No ${kindFilter !== 'all' ? KIND_LABELS[kindFilter].toLowerCase() : ''} activity recorded for this channel yet.`}
        />
      ) : (
        <div className="space-y-2">
          {entries.map((e) => (
            <Card className="p-3 text-sm" key={e.runId} variant="inset">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap text-paper-100">
                    {e.userText ?? (
                      <span className="italic text-paper-500">
                        {e.kind === 'mention'
                          ? 'No message captured'
                          : 'Started on its own schedule'}
                      </span>
                    )}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-paper-500">
                    <Badge tone={KIND_TONES[e.kind]} variant="text">
                      {KIND_LABELS[e.kind]}
                    </Badge>
                    <span>{slackUserLabel(names, e.userSlackId)}</span>
                    <span>· {formatRelativeTime(e.createdAt)}</span>
                    <span>· {e.status}</span>
                    <span>· {formatCost(typeof e.costUsd === 'number' ? e.costUsd : null)}</span>
                    <span>
                      · {formatTokens(e.tokensInput)} in / {formatTokens(e.tokensOutput)} out
                    </span>
                  </div>
                </div>
                <Link
                  className="shrink-0 text-xs text-ember-400 hover:underline"
                  href={`/runs/${e.runId}`}
                >
                  View run →
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
