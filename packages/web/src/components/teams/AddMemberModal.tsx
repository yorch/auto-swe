'use client';

import { useEffect, useState } from 'react';
import { EligibleUserSelect } from '@/components/EligibleUserSelect';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { useAddTeamMember } from '@/hooks/useTeams';
import { useEligibleUsers } from '@/hooks/useUsers';
import { errMsg } from '@/lib/errors';

type Role = 'ADMIN' | 'LEAD' | 'ENGINEER';

export function AddMemberModal({
  open,
  onClose,
  teamId,
  existingUserIds,
}: {
  open: boolean;
  onClose: () => void;
  teamId: string;
  existingUserIds: string[];
}) {
  const eligible = useEligibleUsers(existingUserIds);
  const add = useAddTeamMember(teamId);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<Role>('ENGINEER');
  const [error, setError] = useState<string | null>(null);

  // Two effects, not one — keeping the role/error reset gated to `open` only
  // means typing or selecting doesn't get stomped when `eligible` re-resolves
  // to a new array reference on the next render.
  useEffect(() => {
    if (!open) {
      return;
    }
    setRole('ENGINEER');
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    // Default-select the first eligible user, but only once — preserve any
    // explicit choice the admin already made.
    setUserId((prev) => prev || (eligible[0]?.id ?? ''));
  }, [open, eligible]);

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
      subtitle="Pick a user and choose their role within this team."
      title="Add a member"
    >
      <form className="space-y-5" onSubmit={handleSubmit}>
        <EligibleUserSelect eligible={eligible} onChange={setUserId} value={userId} />
        <Select
          id="role"
          label="Team role"
          onChange={(e) => setRole(e.target.value as Role)}
          value={role}
        >
          <option value="ENGINEER">ENGINEER</option>
          <option value="LEAD">LEAD</option>
          <option value="ADMIN">ADMIN</option>
        </Select>
        {error && (
          <p className="font-mono text-[10px] uppercase tracking-wider text-brick-400">{error}</p>
        )}
        <div className="flex items-center justify-end gap-3 border-t border-ink-600 pt-4">
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={add.isPending || eligible.length === 0} type="submit" variant="primary">
            {add.isPending ? 'Adding…' : 'Add member'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
