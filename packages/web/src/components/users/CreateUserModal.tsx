'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { type CreatedUser, useCreateUser } from '@/hooks/useUsers';
import { errMsg } from '@/lib/errors';

type Role = 'ADMIN' | 'LEAD' | 'ENGINEER';

export function CreateUserModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateUser();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('ENGINEER');
  const [password, setPassword] = useState('');
  const [slackId, setSlackId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<CreatedUser | null>(null);

  function reset() {
    setEmail('');
    setRole('ENGINEER');
    setPassword('');
    setSlackId('');
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await create.mutateAsync({
        email: email.trim(),
        password: password.trim() || undefined,
        role,
        slackId: slackId.trim() || undefined,
      });
      const created = res.data;
      reset();
      if (created.temporaryPassword) {
        // Defer parent close — we want to show the one-time password modal first.
        setRevealed(created);
      } else {
        onClose();
      }
    } catch (err) {
      setError(errMsg(err, 'Failed to create user'));
    }
  }

  function handleRevealClose() {
    setRevealed(null);
    onClose();
  }

  return (
    <>
      <Modal
        onClose={onClose}
        open={open && revealed === null}
        subtitle="Skips the invite/magic-link dance — useful for service accounts or when SMTP/Resend isn't configured. Pre-active, pre-membered to the default team."
        title="Create a user directly"
      >
        <form className="space-y-5" onSubmit={handleSubmit}>
          <Input
            autoFocus
            label="Email"
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@workshop.dev"
            required
            type="email"
            value={email}
          />
          <Select
            id="new-user-role"
            label="Role"
            onChange={(e) => setRole(e.target.value as Role)}
            value={role}
          >
            <option value="ENGINEER">ENGINEER</option>
            <option value="LEAD">LEAD</option>
            <option value="ADMIN">ADMIN</option>
          </Select>
          <Input
            hint="Min 8 chars. Leave blank to auto-generate one (shown once)."
            label="Password (optional)"
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            type="password"
            value={password}
          />
          <Input
            hint="Optional — link a Slack user ID now or via the user's settings later."
            label="Slack user ID (optional)"
            onChange={(e) => setSlackId(e.target.value)}
            placeholder="U01ABCDEFGH"
            value={slackId}
          />
          {error && <Alert>{error}</Alert>}
          <ModalFooter
            isPending={create.isPending}
            onCancel={onClose}
            pendingLabel="Creating…"
            submitLabel="Create user"
          />
        </form>
      </Modal>

      <Modal
        eyebrow="§ Copy now — shown only once"
        onClose={handleRevealClose}
        open={revealed !== null}
        subtitle="The user can sign in via email + password and rotate it from the login page's password-reset flow."
        title={revealed ? `Temporary password for ${revealed.email}` : ''}
      >
        {revealed?.temporaryPassword && (
          <div className="space-y-4">
            <div className="rounded-sm border border-ember-400/60 bg-ember-400/5 p-4">
              <code className="block break-all font-mono text-sm text-ember-200">
                {revealed.temporaryPassword}
              </code>
            </div>
            <CopyButton value={revealed.temporaryPassword} />
            <div className="flex items-center justify-end border-t border-ink-600 pt-4">
              <Button onClick={handleRevealClose} type="button" variant="ghost">
                I have it
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
