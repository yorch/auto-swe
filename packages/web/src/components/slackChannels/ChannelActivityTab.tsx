'use client';

import { useState } from 'react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Toolbar } from '@/components/ui/Toolbar';
import {
  type ChannelAuditKind,
  type SlackChannel,
  useChannelAudit,
} from '@/hooks/useSlackChannels';
import { useUsers } from '@/hooks/useUsers';
import { requestHref } from '@/lib/requestDisplay';
import { emailsBySlackId, slackUserLabel } from '@/lib/slackUserLabel';
import { formatCost, formatDate, formatRelativeTime, formatTokens } from '@/lib/utils';

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
      <Toolbar
        end={
          entries && entries.length > 0 ? (
            <span className="text-xs text-paper-500 tabular-nums">
              {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}
            </span>
          ) : undefined
        }
      >
        <SegmentedControl
          ariaLabel="Filter activity by trigger"
          onChange={setKindFilter}
          options={(['all', 'mention', 'ambient', 'reactive'] as const).map((k) => ({
            label: KIND_LABELS[k],
            value: k,
          }))}
          value={kindFilter}
        />
      </Toolbar>
      <p className="text-[13px] text-paper-400">
        Who triggered the assistant in this channel, what they asked, and what it did. Each entry
        links to the full run.
      </p>

      {isLoading ? (
        <SkeletonRows rows={3} />
      ) : isError ? (
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
          bordered
          hint={
            kindFilter === 'all'
              ? 'Mentions, scheduled digests and reactive interjections appear here as they happen.'
              : 'Try another trigger, or All.'
          }
          icon="chat"
          title={
            kindFilter === 'all'
              ? 'No activity recorded for this channel yet'
              : `No ${KIND_LABELS[kindFilter].toLowerCase()} recorded for this channel yet`
          }
        />
      ) : (
        <div className="space-y-2">
          {entries.map((e) => (
            <Card className="p-4 text-sm" key={e.runId} variant="inset">
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
                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-paper-500">
                    <Badge tone={KIND_TONES[e.kind]} variant="outline">
                      {KIND_LABELS[e.kind]}
                    </Badge>
                    <StatusBadge status={e.status} />
                    <span className="text-paper-300">{slackUserLabel(names, e.userSlackId)}</span>
                    <span aria-hidden>·</span>
                    <time dateTime={e.createdAt} title={formatDate(e.createdAt)}>
                      {formatRelativeTime(e.createdAt)}
                    </time>
                    <span aria-hidden>·</span>
                    <span className="tabular-nums">
                      {formatCost(typeof e.costUsd === 'number' ? e.costUsd : null)}
                    </span>
                    <span aria-hidden>·</span>
                    <span className="tabular-nums">
                      {formatTokens(e.tokensInput)} in / {formatTokens(e.tokensOutput)} out
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {e.workRequestId && (
                    <ButtonLink href={`/runs/${e.runId}`} size="sm" variant="ghost">
                      Diagnostics
                    </ButtonLink>
                  )}
                  <ButtonLink
                    href={e.workRequestId ? requestHref(e.workRequestId) : `/runs/${e.runId}`}
                    size="sm"
                  >
                    View run
                    <Icon name="arrowRight" size={13} />
                  </ButtonLink>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
