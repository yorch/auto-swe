'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { useInviteUser } from '@/hooks/useUsers';
import { errMsg } from '@/lib/errors';
import { platformRoleLabel } from '@/lib/govLabels';

type Role = 'ADMIN' | 'LEAD' | 'ENGINEER';

const ROLE_OPTIONS = (['ENGINEER', 'LEAD', 'ADMIN'] as const).map((r) => ({
  label: platformRoleLabel(r),
  value: r,
}));

/** Invites one person by email: a magic link, and an already-approved account on the default team. */
export function InviteUserModal({
  onClose,
  onInvited,
  open,
}: {
  onClose: () => void;
  /** Called with the address after the invite is sent. */
  onInvited: (email: string) => void;
  open: boolean;
}) {
  const invite = useInviteUser();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('ENGINEER');
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setError(null);
    onClose();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const address = email.trim();
    try {
      await invite.mutateAsync({ email: address, role });
      setEmail('');
      setRole('ENGINEER');
      onInvited(address);
      onClose();
    } catch (err) {
      setError(errMsg(err, 'Invite failed'));
    }
  };

  return (
    <Modal
      onClose={close}
      open={open}
      subtitle="They get a magic-link email and join the default team, already approved. If email delivery is not configured, create the user directly instead."
      title="Invite a teammate"
    >
      <form className="space-y-5" onSubmit={submit}>
        <Input
          autoFocus
          error={error ?? undefined}
          label="Email"
          name="invite-email"
          onChange={(e) => {
            setEmail(e.target.value);
            setError(null);
          }}
          placeholder="teammate@workshop.dev"
          required
          type="email"
          value={email}
        />
        <Select
          id="invite-role"
          label="Role"
          onChange={(v) => setRole(v as Role)}
          options={ROLE_OPTIONS}
          value={role}
        />
        <ModalFooter
          isPending={invite.isPending}
          onCancel={close}
          pendingLabel="Sending…"
          submitLabel="Send invite"
        />
      </form>
    </Modal>
  );
}
