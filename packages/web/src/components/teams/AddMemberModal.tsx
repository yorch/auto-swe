'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useAddTeamMember, useUsers } from '@/hooks/useWorkflows';

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
  const { data: users = [] } = useUsers();
  const add = useAddTeamMember(teamId);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<Role>('ENGINEER');
  const [error, setError] = useState<string | null>(null);

  const eligible = users.filter((u) => !existingUserIds.includes(u.id) && u.isActive);

  useEffect(() => {
    if (!open) return;
    setUserId(eligible[0]?.id ?? '');
    setRole('ENGINEER');
    setError(null);
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
      setError(err instanceof Error ? err.message : 'Failed to add member');
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
        <div className="space-y-1.5">
          <label
            className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
            htmlFor="user"
          >
            User
          </label>
          {eligible.length === 0 ? (
            <p className="text-xs text-brick-400">
              No active users left to add. Invite one from{' '}
              <span className="text-paper-200">/users</span> first.
            </p>
          ) : (
            <select
              className="h-10 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-3 text-sm text-paper-100 outline-none focus:border-ember-400"
              id="user"
              onChange={(e) => setUserId(e.target.value)}
              required
              value={userId}
            >
              {eligible.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email} · {u.role}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="space-y-1.5">
          <label
            className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
            htmlFor="role"
          >
            Team role
          </label>
          <select
            className="h-10 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-3 text-sm text-paper-100 outline-none focus:border-ember-400"
            id="role"
            onChange={(e) => setRole(e.target.value as Role)}
            value={role}
          >
            <option value="ENGINEER">ENGINEER</option>
            <option value="LEAD">LEAD</option>
            <option value="ADMIN">ADMIN</option>
          </select>
        </div>
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
