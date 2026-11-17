'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import { useCreateTeamBudgetRequest } from '@/hooks/useTeamBudgetRequests';
import { ApiError } from '@/lib/api';
import { errMsg } from '@/lib/errors';

const MAX_REASON = 500;

function submitError(e: unknown): string {
  if (e instanceof ApiError && e.status === 409) {
    return 'A request is already pending for this team.';
  }
  return errMsg(e, 'Could not send the request.');
}

/**
 * Where a lead who cannot edit the team's cap asks an admin to change it. The request carries a
 * reason and no amount: the admin decides the number.
 */
export function TeamBudgetRequestDialog({
  onClose,
  open,
  teamId,
}: {
  onClose: () => void;
  open: boolean;
  teamId: string;
}) {
  const create = useCreateTeamBudgetRequest(teamId);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const trimmed = reason.trim();

  function close() {
    setReason('');
    setError(null);
    setSent(false);
    create.reset();
    onClose();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (trimmed.length === 0) {
      return;
    }
    setError(null);
    try {
      await create.mutateAsync({ reason: trimmed });
      setSent(true);
    } catch (err) {
      setError(submitError(err));
    }
  }

  return (
    <Modal
      dismissible={!create.isPending}
      onClose={close}
      open={open}
      subtitle="An admin sees your reason and decides the new cap."
      title="Request a budget change"
    >
      {sent ? (
        <div className="space-y-4">
          <Alert variant="success">Request sent.</Alert>
          <ModalFooter cancelLabel="Close" onCancel={close} />
        </div>
      ) : (
        <form className="space-y-3" onSubmit={submit}>
          <Textarea
            compact
            label="Reason"
            maxLength={MAX_REASON}
            mono={false}
            onChange={(e) => setReason(e.target.value)}
            rows={5}
            value={reason}
          />
          <p className="text-right text-xs text-paper-500">
            {reason.length}/{MAX_REASON}
          </p>
          {error && <Alert>{error}</Alert>}
          <ModalFooter
            disabled={trimmed.length === 0}
            isPending={create.isPending}
            onCancel={close}
            pendingLabel="Sending…"
            submitLabel="Send request"
          />
        </form>
      )}
    </Modal>
  );
}
