'use client';

import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import { useCreateJoinRequest } from '@/hooks/useJoinRequests';
import {
  buildCreateBody,
  type DirectoryTeam,
  joinRequestErrorMessage,
  lengthState,
  MAX_JOIN_REQUEST_MESSAGE_LENGTH,
} from '@/lib/joinRequests';

/** Asks to join one team, with an optional note for the people who decide. */
export function RequestToJoinDialog({
  onClose,
  onSent,
  open,
  team,
}: {
  onClose: () => void;
  /** Called after the request was created, with the team it went to. */
  onSent: (team: DirectoryTeam) => void;
  open: boolean;
  team: DirectoryTeam | null;
}) {
  const create = useCreateJoinRequest(team?.id ?? '');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setMessage('');
      setError(null);
    }
  }, [open]);

  const length = lengthState(message, MAX_JOIN_REQUEST_MESSAGE_LENGTH);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!team || length.over) {
      return;
    }
    setError(null);
    try {
      await create.mutateAsync(buildCreateBody(message));
      onSent(team);
      onClose();
    } catch (err) {
      setError(joinRequestErrorMessage(err));
    }
  }

  return (
    <Modal
      onClose={onClose}
      open={open}
      subtitle={
        team
          ? `${team.name} in ${team.orgName}. The team's leads and admins decide.`
          : 'The team’s leads and admins decide.'
      }
      title={team ? `Request to join ${team.name}` : 'Request to join'}
    >
      <form className="space-y-5" onSubmit={submit}>
        <Textarea
          hint={`${length.count} / ${MAX_JOIN_REQUEST_MESSAGE_LENGTH} characters`}
          hintTone={length.over ? 'warning' : undefined}
          label="Message (optional)"
          maxLength={MAX_JOIN_REQUEST_MESSAGE_LENGTH}
          mono={false}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Say why you would like to join."
          rows={4}
          value={message}
        />
        {team?.orgId && (
          <p className="text-xs text-paper-500">
            If you are not a member of {team.orgName}, an administrator of that organization must
            approve you as well.
          </p>
        )}
        {error && <Alert>{error}</Alert>}
        <ModalFooter
          disabled={length.over}
          isPending={create.isPending}
          onCancel={onClose}
          pendingLabel="Sending…"
          submitLabel="Send request"
        />
      </form>
    </Modal>
  );
}
