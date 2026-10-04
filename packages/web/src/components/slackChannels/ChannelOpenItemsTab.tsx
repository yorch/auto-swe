'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
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
import { formatRelativeTime } from '@/lib/utils';

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
      <SegmentedControl
        ariaLabel="Filter open items by status"
        onChange={setStatusFilter}
        options={(['OPEN', 'RESOLVED', 'DISMISSED', 'all'] as const).map((s) => ({
          label: s === 'all' ? 'All' : STATUS_LABELS[s],
          value: s,
        }))}
        value={statusFilter}
      />

      {actionError && <Alert>{actionError}</Alert>}

      <QueryBoundary error={loadError} isError={isError} isLoading={isLoading} label="open items">
        {!items || items.length === 0 ? (
          <EmptyState
            className="py-4"
            title={`No ${statusFilter !== 'all' ? STATUS_LABELS[statusFilter].toLowerCase() : ''} items for this channel.`}
          />
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <Card className="p-3 text-sm" key={item.id} variant="inset">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap text-paper-100">{item.description}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-paper-500">
                      <Badge tone={STATUS_TONES[item.status]} variant="text">
                        {STATUS_LABELS[item.status]}
                      </Badge>
                      <span>Opened {formatRelativeTime(item.createdAt)}</span>
                      {item.ownerUserId && (
                        <span>· Owner: {slackUserLabel(names, item.ownerUserId)}</span>
                      )}
                      {item.lastNudgedAt && (
                        <span>· Reminded {formatRelativeTime(item.lastNudgedAt)}</span>
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
                        Resolve
                      </Button>
                      <Button
                        disabled={updateItem.isPending}
                        onClick={() => handleStatus(item, 'DISMISSED')}
                        size="sm"
                        variant="danger"
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
