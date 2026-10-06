'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { SaveBar } from '@/components/ui/SaveBar';
import { useFormState } from '@/hooks/useFormState';
import {
  type SlackChannel,
  useDeleteSlackChannel,
  useUpdateSlackChannel,
} from '@/hooks/useSlackChannels';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
import { errMsg } from '@/lib/errors';
import {
  type ChannelFormErrors,
  channelToForm,
  formToUpdateBody,
  validateChannelForm,
} from '@/lib/slackChannelForm';
import { ChannelForm } from './ChannelForm';

/** Edit a registered channel, switch it on or off, or delete it. */
export function ChannelSettingsTab({ channel }: { channel: SlackChannel }) {
  const router = useRouter();
  const update = useUpdateSlackChannel();
  const remove = useDeleteSlackChannel();
  const state = useFormState(channelToForm(channel));
  const { form, setField, markSaved, markFailed, clearStatus } = state;
  useUnsavedChangesGuard(state.isDirty);
  const [errors, setErrors] = useState<ChannelFormErrors>({});
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const name = channel.name ?? 'this channel';
  const memoryPhrase =
    channel.memoryItemCount == null
      ? 'all of its memory'
      : `${channel.memoryItemCount} memory item${channel.memoryItemCount === 1 ? '' : 's'}`;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    clearStatus();
    const found = validateChannelForm(form, 'edit');
    setErrors(found);
    if (Object.keys(found).length > 0) {
      markFailed('Fix the highlighted fields, then save again.');
      return;
    }
    try {
      await update.mutateAsync({ id: channel.id, ...formToUpdateBody(form) });
      markSaved(form);
    } catch (err) {
      markFailed(errMsg(err, 'Could not save the settings'));
    }
  }

  async function setActive(isActive: boolean) {
    setStatusError(null);
    try {
      await update.mutateAsync({ id: channel.id, isActive });
    } catch (err) {
      setStatusError(errMsg(err, `Could not ${isActive ? 'activate' : 'deactivate'} the channel`));
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <ChannelForm
          errors={errors}
          form={form}
          mode="edit"
          onChange={(key, value) => {
            setField(key, value);
            setErrors((prev) => ({ ...prev, [key]: undefined }));
          }}
        />
        <SaveBar
          dirtyCount={state.dirtyCount}
          error={state.error}
          onDiscard={() => {
            state.discard();
            setErrors({});
          }}
          pending={update.isPending}
          saved={state.saved}
          savedMessage="Settings saved."
        />
      </form>

      <Card>
        <CardHeader>
          <CardTitle eyebrow="Status">Availability</CardTitle>
        </CardHeader>
        {statusError && <Alert className="mb-3">{statusError}</Alert>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-prose text-sm text-paper-400">
            {channel.isActive
              ? 'The assistant is responding in this channel.'
              : 'The assistant is switched off here. It ignores messages until you activate it again.'}
          </p>
          {channel.isActive ? (
            <Button onClick={() => setConfirmDeactivate(true)} variant="secondary">
              Deactivate
            </Button>
          ) : (
            <Button disabled={update.isPending} onClick={() => setActive(true)} variant="primary">
              Activate
            </Button>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle eyebrow="Danger zone">Delete this channel</CardTitle>
        </CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-prose text-sm text-paper-400">
            Removes the channel's registration together with everything the assistant remembers
            about it ({memoryPhrase}) and every open item it is tracking. This cannot be undone.
          </p>
          <Button onClick={() => setConfirmDelete(true)} variant="danger">
            Delete channel
          </Button>
        </div>
      </Card>

      <ConfirmModal
        confirmLabel="Deactivate"
        dangerous
        message={`The assistant stops responding in ${name} until you activate it again. Its memory and open items are kept.`}
        onClose={() => setConfirmDeactivate(false)}
        onConfirm={async () => {
          await update.mutateAsync({ id: channel.id, isActive: false });
        }}
        open={confirmDeactivate}
        title="Deactivate channel?"
      />
      <ConfirmModal
        closeOnConfirm={false}
        confirmLabel="Delete channel"
        dangerous
        message={`Delete ${name}? ${memoryPhrase.charAt(0).toUpperCase()}${memoryPhrase.slice(1)} and its open items are deleted with it, and the assistant stops responding there. This cannot be undone.`}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await remove.mutateAsync(channel.id);
          router.replace('/govern/slack-channels');
        }}
        open={confirmDelete}
        title="Delete Slack channel?"
      />
    </div>
  );
}
