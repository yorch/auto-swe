'use client';

import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { useInviteTeamMember } from '@/hooks/useTeams';
import { ApiError } from '@/lib/api';
import { errMsg } from '@/lib/errors';
import { DEFAULT_TEAM_ROLE, type TeamRoleValue, teamRoleLabel } from '@/lib/roleLabels';

export function InviteTeamMemberModal({
  open,
  onClose,
  teamId,
  grantableRoles,
  onInvited,
}: {
  open: boolean;
  onClose: () => void;
  teamId: string;
  grantableRoles: TeamRoleValue[];
  onInvited: (message: string) => void;
}) {
  const invite = useInviteTeamMember(teamId);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRoleValue>(DEFAULT_TEAM_ROLE);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setEmail('');
      setRole(DEFAULT_TEAM_ROLE);
      setError(null);
    }
  }, [open]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const { data } = await invite.mutateAsync({ email: email.trim().toLowerCase(), role });
      onInvited(
        `${data.email}: ${data.isActive ? 'account active and approved' : 'waiting for platform approval'}. A sign-in link is requested by email.`
      );
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'USER_EXISTS'
          ? 'This email already has an account. Use Add member instead.'
          : errMsg(err, 'Unable to invite member')
      );
    }
  }
  return (
    <Modal
      onClose={onClose}
      open={open}
      subtitle="Invite a new account into this team and its organization."
      title="Invite by email"
    >
      <form className="space-y-5" onSubmit={submit}>
        <Input
          autoFocus
          label="Email"
          onChange={(e) => setEmail(e.target.value)}
          required
          type="email"
          value={email}
        />
        <Select
          label="Team role"
          onChange={(value) => setRole(value as TeamRoleValue)}
          options={grantableRoles.map((r) => ({ label: teamRoleLabel(r), value: r }))}
          value={role}
        />
        {error && <Alert>{error}</Alert>}
        <ModalFooter
          disabled={!email.trim()}
          isPending={invite.isPending}
          onCancel={onClose}
          pendingLabel="Inviting…"
          submitLabel="Send invite"
        />
      </form>
    </Modal>
  );
}
