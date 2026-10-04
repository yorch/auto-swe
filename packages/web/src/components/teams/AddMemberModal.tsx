'use client';

import type { Role } from '@auto-swe/shared';
import { useEffect, useState } from 'react';
import { MemberUserPicker } from '@/components/MemberUserPicker';
import { Alert } from '@/components/ui/Alert';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { useAddTeamMember } from '@/hooks/useTeams';
import { errMsg } from '@/lib/errors';

const ALL_ROLES: Role[] = ['ENGINEER', 'LEAD', 'ADMIN'];

export function AddMemberModal({
  open,
  onClose,
  teamId,
  existingUserIds,
  grantableRoles = ALL_ROLES,
}: {
  open: boolean;
  onClose: () => void;
  teamId: string;
  existingUserIds: string[];
  /** Team roles the caller may grant; the gateway refuses anything above their own. */
  grantableRoles?: Role[];
}) {
  const add = useAddTeamMember(teamId);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<Role>('ENGINEER');
  const [error, setError] = useState<string | null>(null);
  const [pickerKey, setPickerKey] = useState(0);

  useEffect(() => {
    if (!open) {
      return;
    }
    setRole('ENGINEER');
    setError(null);
    setUserId('');
    // Remount the picker so its own lookup field starts empty too.
    setPickerKey((k) => k + 1);
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!userId) {
      setError('Pick a user');
      return;
    }
    try {
      await add.mutateAsync({ role, userId });
      onClose();
    } catch (err) {
      setError(errMsg(err, 'Failed to add member'));
    }
  }

  return (
    <Modal
      onClose={onClose}
      open={open}
      subtitle="Choose a user and their role within this team."
      title="Add a member"
    >
      <form className="space-y-5" onSubmit={handleSubmit}>
        <MemberUserPicker
          existingUserIds={existingUserIds}
          key={pickerKey}
          onChange={setUserId}
          value={userId}
        />
        <Select
          id="role"
          label="Team role"
          onChange={(v) => setRole(v as Role)}
          options={grantableRoles.map((r) => ({ label: r, value: r }))}
          value={role}
        />
        {error && <Alert>{error}</Alert>}
        <ModalFooter
          disabled={!userId}
          isPending={add.isPending}
          onCancel={onClose}
          pendingLabel="Adding…"
          submitLabel="Add member"
        />
      </form>
    </Modal>
  );
}
