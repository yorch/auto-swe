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
import { platformRoleLabel } from '@/lib/govLabels';

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
        subtitle="No invite email: the account is active at once and joins the default team. Useful for service accounts, or when email delivery is not configured."
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
            onChange={(v) => setRole(v as Role)}
            options={(['ENGINEER', 'LEAD', 'ADMIN'] as const).map((r) => ({
              label: platformRoleLabel(r),
              value: r,
            }))}
            value={role}
          />
          <Input
            hint="At least 8 characters. Leave blank to generate one, shown once."
            label="Password (optional)"
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            type="password"
            value={password}
          />
          <Input
            hint="Link a Slack user now, or later from the user's settings."
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
        closeOnBackdropClick={false}
        eyebrow="Shown only once"
        onClose={handleRevealClose}
        open={revealed !== null}
        subtitle="Copy it now and pass it on securely. The user signs in with email and password, and can change it through the password reset on the sign-in page."
        title={revealed ? `Temporary password for ${revealed.email}` : ''}
      >
        {revealed?.temporaryPassword && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-lg border border-ember-400/40 bg-ember-400/5 p-4">
              <code className="min-w-0 flex-1 break-all font-mono text-sm text-ember-200">
                {revealed.temporaryPassword}
              </code>
              <CopyButton value={revealed.temporaryPassword} />
            </div>
            <div className="flex items-center justify-end border-t border-ink-600 pt-4">
              <Button onClick={handleRevealClose} type="button" variant="primary">
                I have it
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
