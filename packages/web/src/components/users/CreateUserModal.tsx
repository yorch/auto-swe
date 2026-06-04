'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { type CreatedUser, useCreateUser } from '@/hooks/useWorkflows';

type Role = 'ADMIN' | 'LEAD' | 'ENGINEER';

export function CreateUserModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateUser();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('ENGINEER');
  const [password, setPassword] = useState('');
  const [slackId, setSlackId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<CreatedUser | null>(null);
  const [copied, setCopied] = useState(false);

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
      setError(err instanceof Error ? err.message : 'Failed to create user');
    }
  }

  async function handleCopy() {
    if (!revealed?.temporaryPassword) {
      return;
    }
    try {
      await navigator.clipboard.writeText(revealed.temporaryPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — user can select manually
    }
  }

  function handleRevealClose() {
    setRevealed(null);
    setCopied(false);
    onClose();
  }

  return (
    <>
      <Modal
        eyebrow="§ Create user"
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
          <div className="space-y-1.5">
            <label
              className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
              htmlFor="new-user-role"
            >
              Role
            </label>
            <select
              className="h-10 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-3 text-sm text-paper-100 outline-none focus:border-ember-400"
              id="new-user-role"
              onChange={(e) => setRole(e.target.value as Role)}
              value={role}
            >
              <option value="ENGINEER">ENGINEER</option>
              <option value="LEAD">LEAD</option>
              <option value="ADMIN">ADMIN</option>
            </select>
          </div>
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
          {error && (
            <p className="font-mono text-[10px] uppercase tracking-wider text-brick-400">{error}</p>
          )}
          <div className="flex items-center justify-end gap-3 border-t border-ink-600 pt-4">
            <Button onClick={onClose} type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={create.isPending} type="submit" variant="primary">
              {create.isPending ? 'Creating…' : 'Create user'}
            </Button>
          </div>
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
            <Button onClick={handleCopy} size="sm" variant="secondary">
              {copied ? '✓ Copied' : 'Copy to clipboard'}
            </Button>
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
