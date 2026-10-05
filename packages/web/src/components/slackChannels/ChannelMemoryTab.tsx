'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Textarea } from '@/components/ui/Textarea';
import {
  type MemoryItemDto,
  type SlackChannel,
  useChannelMemory,
  useDeleteChannelMemory,
  useUpdateChannelMemory,
} from '@/hooks/useSlackChannels';
import { errMsg } from '@/lib/errors';
import { formatDate } from '@/lib/utils';
import { QuoteConfirmModal } from './QuoteConfirmModal';

function MemoryItemEditForm({
  channelId,
  item,
  onCancel,
  onSaved,
}: {
  channelId: string;
  item: MemoryItemDto;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const updateMemory = useUpdateChannelMemory();
  const [lessonSummary, setLessonSummary] = useState(item.lessonSummary);
  const [rationale, setRationale] = useState(item.rationale);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const summary = lessonSummary.trim();
    const why = rationale.trim();
    if (!summary && !why) {
      setError('Fill in at least one of the two fields.');
      return;
    }
    try {
      await updateMemory.mutateAsync({
        channelId,
        lessonSummary: summary || undefined,
        memoryId: item.id,
        rationale: why || undefined,
      });
      onSaved();
    } catch (err) {
      setError(errMsg(err, 'Could not update this memory'));
    }
  }

  return (
    <form className="mt-2 space-y-2" onSubmit={handleSubmit}>
      <Textarea
        compact
        id={`mem-edit-lesson-${item.id}`}
        label="What was learned"
        onChange={(e) => setLessonSummary(e.target.value)}
        rows={3}
        value={lessonSummary}
      />
      <Textarea
        compact
        id={`mem-edit-rationale-${item.id}`}
        label="Why it matters"
        onChange={(e) => setRationale(e.target.value)}
        rows={2}
        value={rationale}
      />
      <p className="text-xs text-paper-500">
        The memory is re-indexed in the background after saving.
      </p>
      {error && <Alert>{error}</Alert>}
      <ModalFooter
        isPending={updateMemory.isPending}
        onCancel={onCancel}
        pendingLabel="Saving…"
        submitLabel="Save"
      />
    </form>
  );
}

/** What the channel assistant remembers about this channel, with edit and delete. */
export function ChannelMemoryTab({ channel }: { channel: SlackChannel }) {
  const [showConsolidated, setShowConsolidated] = useState(false);
  const {
    data: items,
    isLoading,
    isError,
    isFetching,
    refetch,
    error: loadError,
  } = useChannelMemory(channel.id, showConsolidated);
  const deleteMemory = useDeleteChannelMemory();
  const [confirmItem, setConfirmItem] = useState<MemoryItemDto | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <Checkbox
        checked={showConsolidated}
        label="Show merged (archived) memories"
        onChange={(e) => setShowConsolidated(e.target.checked)}
      />
      <QueryBoundary
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="channel memory"
        onRetry={() => void refetch()}
      >
        {!items || items.length === 0 ? (
          <EmptyState className="py-6" title="No memory yet for this channel." />
        ) : (
          <ul className="divide-y divide-ink-600">
            {items.map((item) => {
              const consolidatedAt = item.consolidatedAt;
              const isConsolidated = !!consolidatedAt;
              return (
                <li className={`py-3 ${isConsolidated ? 'opacity-50' : ''}`} key={item.id}>
                  {!isConsolidated && editingId === item.id ? (
                    <MemoryItemEditForm
                      channelId={channel.id}
                      item={item}
                      onCancel={() => setEditingId(null)}
                      onSaved={() => setEditingId(null)}
                    />
                  ) : (
                    <div className="flex flex-wrap items-start gap-4">
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="whitespace-pre-wrap text-sm leading-snug text-paper-100">
                          {item.lessonSummary}
                        </p>
                        <p className="whitespace-pre-wrap text-xs leading-snug text-paper-500">
                          {item.rationale}
                        </p>
                        <div className="flex flex-wrap items-center gap-3">
                          {consolidatedAt && (
                            <Badge tone="muted">Merged {formatDate(consolidatedAt)}</Badge>
                          )}
                          <span className="text-xs text-paper-500">
                            Added {formatDate(item.createdAt)}
                          </span>
                        </div>
                      </div>
                      {!isConsolidated && (
                        <div className="flex items-center gap-2">
                          <Button
                            onClick={() => setEditingId(item.id)}
                            size="sm"
                            variant="secondary"
                          >
                            Edit
                          </Button>
                          <Button onClick={() => setConfirmItem(item)} size="sm" variant="danger">
                            Delete
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </QueryBoundary>

      <QuoteConfirmModal
        confirmLabel="Delete memory"
        intro="Delete this memory? The assistant will no longer use it. This cannot be undone."
        onClose={() => setConfirmItem(null)}
        onConfirm={async () => {
          if (confirmItem) {
            await deleteMemory.mutateAsync({ channelId: channel.id, memoryId: confirmItem.id });
          }
        }}
        open={confirmItem !== null}
        quote={confirmItem?.lessonSummary ?? ''}
        title="Delete memory"
      />
    </div>
  );
}
