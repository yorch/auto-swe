'use client';

import { useState } from 'react';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Textarea } from '@/components/ui/Textarea';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import {
  type MemoryItemDto,
  type SlackChannel,
  useChannelMemory,
  useDeleteChannelMemory,
  useUpdateChannelMemory,
} from '@/hooks/useSlackChannels';
import { errMsg } from '@/lib/errors';
import { formatDate } from '@/lib/utils';

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
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const shown = (items ?? []).filter(
    (item) => !needle || `${item.lessonSummary}\n${item.rationale}`.toLowerCase().includes(needle)
  );

  return (
    <div className="space-y-4">
      <Toolbar
        end={
          <Checkbox
            checked={showConsolidated}
            label="Show merged (archived) memories"
            onChange={(e) => setShowConsolidated(e.target.checked)}
          />
        }
      >
        <SearchInput
          label="Search channel memory"
          onChange={setQuery}
          placeholder="Search what it remembers…"
          value={query}
        />
      </Toolbar>
      <QueryBoundary
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="channel memory"
        onRetry={() => void refetch()}
      >
        {!items || items.length === 0 ? (
          <EmptyState
            bordered
            hint="The assistant saves what it learns from conversations here, and uses it to ground later replies."
            icon="memory"
            title="No memory yet for this channel"
          />
        ) : shown.length === 0 ? (
          <EmptyState
            action={
              <Button onClick={() => setQuery('')} size="sm">
                Clear search
              </Button>
            }
            icon="search"
            title="No memories match your search"
          />
        ) : (
          <ul className="divide-y divide-ink-600">
            {shown.map((item) => {
              const consolidatedAt = item.consolidatedAt;
              const isConsolidated = !!consolidatedAt;
              return (
                <li className={`py-4 ${isConsolidated ? 'opacity-60' : ''}`} key={item.id}>
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
                        <p className="whitespace-pre-wrap text-[13px] leading-snug text-paper-400">
                          {item.rationale}
                        </p>
                        <div className="flex flex-wrap items-center gap-3 pt-1">
                          {consolidatedAt && (
                            <Badge tone="muted" variant="outline">
                              Merged {formatDate(consolidatedAt)}
                            </Badge>
                          )}
                          <span className="text-xs text-paper-500">
                            Added {formatDate(item.createdAt)}
                          </span>
                        </div>
                      </div>
                      {!isConsolidated && (
                        <ActionMenu
                          items={[
                            {
                              icon: 'edit',
                              id: 'edit',
                              label: 'Edit',
                              onAction: () => setEditingId(item.id),
                            },
                            {
                              icon: 'trash',
                              id: 'delete',
                              label: 'Delete',
                              onAction: () => setConfirmItem(item),
                              tone: 'danger',
                            },
                          ]}
                          label="Actions for this memory"
                        />
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </QueryBoundary>

      <ConfirmModal
        confirmLabel="Delete memory"
        dangerous
        message={
          <div className="space-y-3">
            <p>Delete this memory? The assistant will no longer use it. This cannot be undone.</p>
            <blockquote className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md border-l-2 border-ember-400 bg-ink-900/60 px-3 py-2 text-paper-200">
              {confirmItem?.lessonSummary ?? ''}
            </blockquote>
          </div>
        }
        onClose={() => setConfirmItem(null)}
        onConfirm={async () => {
          if (confirmItem) {
            await deleteMemory.mutateAsync({ channelId: channel.id, memoryId: confirmItem.id });
          }
        }}
        open={confirmItem !== null}
        title="Delete memory"
      />
    </div>
  );
}
