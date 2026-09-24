'use client';

import type { Role } from '@auto-swe/shared';
import { useEffect, useState } from 'react';
import { MemberUserPicker } from '@/components/MemberUserPicker';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
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

  useEffect(() => {
    if (!open) {
      return;
    }
    setRole('ENGINEER');
    setError(null);
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
      eyebrow="§ Add team member"
      onClose={onClose}
      open={open}
      subtitle="Choose a user and their role within this team."
      title="Add a member"
    >
      <form className="space-y-5" onSubmit={handleSubmit}>
        <MemberUserPicker existingUserIds={existingUserIds} onChange={setUserId} value={userId} />
        <Select
          id="role"
          label="Team role"
          onChange={(e) => setRole(e.target.value as Role)}
          value={role}
        >
          {grantableRoles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
        {error && (
          <p className="font-mono text-[10px] uppercase tracking-wider text-brick-400">{error}</p>
        )}
        <div className="flex items-center justify-end gap-3 border-t border-ink-600 pt-4">
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={add.isPending || !userId} type="submit" variant="primary">
            {add.isPending ? 'Adding…' : 'Add member'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
