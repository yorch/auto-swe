'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Toolbar } from '@/components/ui/Toolbar';
import {
  type ChannelOpenItemDto,
  type ChannelOpenItemStatus,
  type SlackChannel,
  useChannelOpenItems,
  useUpdateChannelOpenItem,
} from '@/hooks/useSlackChannels';
import { useUsers } from '@/hooks/useUsers';
import { errMsg } from '@/lib/errors';
import { emailsBySlackId, slackUserLabel } from '@/lib/slackUserLabel';
import { formatDate, formatRelativeTime } from '@/lib/utils';

const STATUS_LABELS: Record<ChannelOpenItemStatus, string> = {
  DISMISSED: 'Dismissed',
  OPEN: 'Open',
  RESOLVED: 'Resolved',
};

const STATUS_TONES: Record<ChannelOpenItemStatus, BadgeTone> = {
  DISMISSED: 'muted',
  OPEN: 'amber',
  RESOLVED: 'moss',
};

/** Follow-ups the assistant is tracking in this channel, which an admin can resolve or dismiss. */
export function ChannelOpenItemsTab({ channel }: { channel: SlackChannel }) {
  const [statusFilter, setStatusFilter] = useState<ChannelOpenItemStatus | 'all'>('OPEN');
  const {
    data: items,
    isLoading,
    isError,
    isFetching,
    refetch,
    error: loadError,
  } = useChannelOpenItems(channel.id, statusFilter);
  const updateItem = useUpdateChannelOpenItem();
  const { data: users } = useUsers();
  const names = emailsBySlackId(users);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleStatus(item: ChannelOpenItemDto, status: ChannelOpenItemStatus) {
    setActionError(null);
    try {
      await updateItem.mutateAsync({ channelId: channel.id, itemId: item.id, status });
    } catch (err) {
      setActionError(errMsg(err, 'Could not update the item'));
    }
  }

  return (
    <div className="space-y-4">
      <Toolbar
        end={
          items && items.length > 0 ? (
            <span className="text-xs text-paper-500 tabular-nums">
              {items.length} item{items.length === 1 ? '' : 's'}
            </span>
          ) : undefined
        }
      >
        <SegmentedControl
          ariaLabel="Filter open items by status"
          onChange={setStatusFilter}
          options={(['OPEN', 'RESOLVED', 'DISMISSED', 'all'] as const).map((s) => ({
            label: s === 'all' ? 'All' : STATUS_LABELS[s],
            value: s,
          }))}
          value={statusFilter}
        />
      </Toolbar>
      <p className="text-[13px] text-paper-400">
        Follow-ups the assistant is tracking here. Resolve an item once it is done, or dismiss it if
        it never needed doing; either way the assistant stops reminding the channel.
      </p>

      {actionError && <Alert>{actionError}</Alert>}

      <QueryBoundary
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="open items"
        onRetry={() => void refetch()}
      >
        {!items || items.length === 0 ? (
          <EmptyState
            bordered
            hint={
              statusFilter === 'OPEN'
                ? 'Nothing is waiting on anyone. The assistant opens an item when a conversation leaves a follow-up.'
                : 'Try another status, or All.'
            }
            icon="inbox"
            title={
              statusFilter === 'all'
                ? 'No items for this channel'
                : `No ${STATUS_LABELS[statusFilter].toLowerCase()} items for this channel`
            }
          />
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <Card className="p-4 text-sm" key={item.id} variant="inset">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap text-paper-100">{item.description}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-paper-500">
                      <Badge dot tone={STATUS_TONES[item.status]} variant="outline">
                        {STATUS_LABELS[item.status]}
                      </Badge>
                      <span title={formatDate(item.createdAt)}>
                        Opened {formatRelativeTime(item.createdAt)}
                      </span>
                      {item.ownerUserId && (
                        <span>
                          · Owner{' '}
                          <span className="text-paper-300">
                            {slackUserLabel(names, item.ownerUserId)}
                          </span>
                        </span>
                      )}
                      {item.lastNudgedAt && (
                        <span title={formatDate(item.lastNudgedAt)}>
                          · Reminded {formatRelativeTime(item.lastNudgedAt)}
                        </span>
                      )}
                    </div>
                  </div>
                  {item.status === 'OPEN' && (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        disabled={updateItem.isPending}
                        onClick={() => handleStatus(item, 'RESOLVED')}
                        size="sm"
                        variant="secondary"
                      >
                        <Icon name="check" size={13} />
                        Resolve
                      </Button>
                      <Button
                        disabled={updateItem.isPending}
                        onClick={() => handleStatus(item, 'DISMISSED')}
                        size="sm"
                        variant="ghost"
                      >
                        Dismiss
                      </Button>
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}
