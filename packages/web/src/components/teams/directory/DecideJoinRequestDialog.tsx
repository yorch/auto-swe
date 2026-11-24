'use client';

import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import {
  COMBINED_APPROVAL_HINT,
  decisionErrorMessage,
  type JoinRequestRow,
  lengthState,
  MAX_JOIN_REQUEST_NOTE_LENGTH,
  requesterLabel,
} from '@/lib/joinRequests';
import { DEFAULT_TEAM_ROLE, type TeamRoleValue, teamRoleLabel } from '@/lib/roleLabels';

export interface DecisionInput {
  role: TeamRoleValue | '';
  note: string;
}

/**
 * Approve or reject one request with an optional note. A team-step approval also offers the role
 * to grant, limited to `roleOptions` (the roles the approver may give); the organization step
 * passes none and shows no role field.
 */
export function DecideJoinRequestDialog({
  alsoCompletesOrgStep = false,
  decision,
  onClose,
  onSubmit,
  open,
  request,
  roleOptions,
  teamName,
}: {
  /** The viewer also manages the request's organization, so a team approval completes both steps. */
  alsoCompletesOrgStep?: boolean;
  decision: 'approve' | 'reject';
  onClose: () => void;
  onSubmit: (input: DecisionInput) => Promise<void>;
  open: boolean;
  request: JoinRequestRow | null;
  roleOptions?: readonly TeamRoleValue[];
  teamName?: string;
}) {
  const [role, setRole] = useState<TeamRoleValue | ''>('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) {
      setRole(DEFAULT_TEAM_ROLE);
      setNote('');
      setError(null);
    }
  }, [open]);

  const length = lengthState(note, MAX_JOIN_REQUEST_NOTE_LENGTH);
  const approving = decision === 'approve';
  const who = request ? requesterLabel(request) : 'this person';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (length.over) {
      return;
    }
    setError(null);
    setPending(true);
    try {
      await onSubmit({ note, role });
      onClose();
    } catch (err) {
      setError(decisionErrorMessage(err, approving ? 'Could not approve' : 'Could not reject'));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      dismissible={!pending}
      onClose={onClose}
      open={open}
      subtitle={
        !approving
          ? `${who} sees the request was declined.`
          : request?.requiresOrgApproval && roleOptions && !alsoCompletesOrgStep
            ? `${who} is not in this organization. Approving passes the request to the organization's admins for a final decision.`
            : `${who} joins ${teamName ?? 'the team'}.`
      }
      title={approving ? 'Approve request' : 'Reject request'}
    >
      <form className="space-y-5" onSubmit={submit}>
        {approving && roleOptions && alsoCompletesOrgStep && (
          <Alert variant="info">{COMBINED_APPROVAL_HINT}</Alert>
        )}
        {approving && roleOptions && roleOptions.length > 0 && (
          <Select
            hint="Never above your own role."
            label="Team role"
            onChange={(v) => setRole(v as TeamRoleValue)}
            options={roleOptions.map((r) => ({ label: teamRoleLabel(r), value: r }))}
            value={role}
          />
        )}
        {approving && !roleOptions && request?.grantedRole && (
          <p className="text-sm text-paper-300">
            Role granted by the team: {teamRoleLabel(request.grantedRole)}
            {request.teamDecisionNote ? ` (“${request.teamDecisionNote}”)` : ''}
          </p>
        )}
        <Textarea
          hint={`${length.count} / ${MAX_JOIN_REQUEST_NOTE_LENGTH} characters`}
          hintTone={length.over ? 'warning' : undefined}
          label="Note (optional)"
          maxLength={MAX_JOIN_REQUEST_NOTE_LENGTH}
          mono={false}
          onChange={(e) => setNote(e.target.value)}
          placeholder={approving ? 'Welcome, or a word about what to do first.' : 'Why not.'}
          rows={3}
          value={note}
        />
        {error && <Alert>{error}</Alert>}
        <ModalFooter
          dangerous={!approving}
          disabled={length.over}
          isPending={pending}
          onCancel={onClose}
          pendingLabel={approving ? 'Approving…' : 'Rejecting…'}
          submitLabel={approving ? 'Approve' : 'Reject'}
        />
      </form>
    </Modal>
  );
}
