'use client';

import { useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { CreateUserModal } from '@/components/users/CreateUserModal';
import { useInviteUser, useUpdateUser, useUsers } from '@/hooks/useWorkflows';
import { cn } from '@/lib/utils';

type Role = 'ADMIN' | 'LEAD' | 'ENGINEER';

export default function UsersPage() {
  const { data: users, isLoading } = useUsers();
  const updateUser = useUpdateUser();
  const inviteUser = useInviteUser();
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('ENGINEER');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteInfo, setInviteInfo] = useState<string | null>(null);
  const [creatingDirect, setCreatingDirect] = useState(false);

  // Partition into pending (sign-ups awaiting approval) vs. active. Pending
  // users get a dedicated top section so admins notice them; the rest go
  // into the regular member table.
  const { pending, active } = useMemo(() => {
    const p: NonNullable<typeof users> = [];
    const a: NonNullable<typeof users> = [];
    for (const u of users ?? []) {
      if (u.isActive) {
        a.push(u);
      } else {
        p.push(u);
      }
    }
    return { active: a, pending: p };
  }, [users]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20 font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500">
        <span className="pulse-dot mr-3 inline-block h-1.5 w-1.5 rounded-full bg-ember-400" />
        loading users…
      </div>
    );
  }

  const handleApprove = (id: string) => updateUser.mutate({ id, patch: { isActive: true } });
  const handleSuspend = (id: string) => updateUser.mutate({ id, patch: { isActive: false } });

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviteError(null);
    setInviteInfo(null);
    try {
      await inviteUser.mutateAsync({ email: inviteEmail, role: inviteRole });
      setInviteInfo(`Invite sent to ${inviteEmail} — they'll receive a magic-link email.`);
      setInviteEmail('');
      setInviteRole('ENGINEER');
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'invite failed');
    }
  };

  return (
    <div className="space-y-10">
      <div className="fade-up">
        <PageHeader
          chapter={`§ Users · ${(users ?? []).length} total · ${pending.length} pending`}
          subtitle="Manage who can sign in to the control plane. Sign-ups via GitHub / Google / magic link start in the pending queue and need admin approval."
          title="Members."
        />
      </div>

      {/* Invite by email — admin sends a magic-link to the address. The
          invitee lands pre-active + pre-membered to the default team.
          For service accounts (or when SMTP/Resend isn't configured),
          "+ Create directly" pops the CreateUserModal which posts to
          POST /api/v1/users and reveals an auto-generated password once. */}
      <section className="fade-up stagger-1">
        <SectionHeader
          actions={
            <Button onClick={() => setCreatingDirect(true)} size="sm" variant="secondary">
              + Create directly
            </Button>
          }
          hint="email + magic link"
          number="01"
          title="Invite a teammate"
        />
        <Card variant="inset">
          {inviteError && (
            <Alert className="mb-3" variant="error">
              {inviteError}
            </Alert>
          )}
          {inviteInfo && (
            <Alert className="mb-3" variant="success">
              {inviteInfo}
            </Alert>
          )}
          <form className="flex flex-wrap items-end gap-3" onSubmit={handleInvite}>
            <div className="flex-1 min-w-[240px]">
              <Input
                label="Email"
                name="invite-email"
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="teammate@workshop.dev"
                required
                type="email"
                value={inviteEmail}
              />
            </div>
            <div>
              <label
                className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
                htmlFor="invite-role"
              >
                Role
              </label>
              <Select
                className="mt-1.5 w-auto"
                id="invite-role"
                onChange={(e) => setInviteRole(e.target.value as Role)}
                value={inviteRole}
              >
                <option value="ENGINEER">ENGINEER</option>
                <option value="LEAD">LEAD</option>
                <option value="ADMIN">ADMIN</option>
              </Select>
            </div>
            <Button disabled={inviteUser.isPending} size="md" type="submit" variant="primary">
              {inviteUser.isPending ? 'Sending…' : 'Send invite →'}
            </Button>
          </form>
        </Card>
      </section>

      {pending.length > 0 && (
        <section className="fade-up stagger-2">
          <SectionHeader
            hint={`${pending.length} awaiting approval`}
            number="02"
            title="Pending sign-ups"
          />
          <Card variant="inset">
            <ul className="divide-y divide-ink-600">
              {pending.map((u) => (
                <li className="flex items-center justify-between py-3" key={u.id}>
                  <div className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400"
                    />
                    <div>
                      <div className="text-sm text-paper-100">{u.email}</div>
                      <div className="font-mono text-[11px] text-paper-500">
                        role: {u.role}
                        {u.memberships && u.memberships.length > 0 && (
                          <>
                            {' · teams: '}
                            {u.memberships
                              .map((m) => m.team?.name)
                              .filter(Boolean)
                              .join(', ')}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <Button
                    disabled={updateUser.isPending}
                    onClick={() => handleApprove(u.id)}
                    size="sm"
                    variant="primary"
                  >
                    {updateUser.isPending ? 'Approving…' : 'Approve →'}
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      <section className={cn('fade-up', pending.length > 0 ? 'stagger-3' : 'stagger-2')}>
        <SectionHeader
          hint={`${active.length} active`}
          number={pending.length > 0 ? '03' : '02'}
          title="Active members"
        />
        <Card className="overflow-hidden p-0" variant="inset">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-600">
                <Th>Email</Th>
                <Th>Role</Th>
                <Th>Slack</Th>
                <Th>Teams</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {active.map((u) => (
                <tr className="border-b border-ink-600 last:border-b-0" key={u.id}>
                  <td className="px-4 py-3 text-sm text-paper-100">{u.email}</td>
                  <td className="px-4 py-3">
                    <span className="rounded border border-ember-400/40 bg-ember-400/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ember-400">
                      {u.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-paper-400">
                    {u.slackId ?? <span className="text-paper-500">—</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-paper-400">
                    {(u.memberships ?? [])
                      .map((m) => m.team?.name)
                      .filter(Boolean)
                      .join(', ') || <span className="text-paper-500">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      disabled={updateUser.isPending}
                      onClick={() => handleSuspend(u.id)}
                      size="sm"
                      variant="ghost"
                    >
                      Suspend
                    </Button>
                  </td>
                </tr>
              ))}
              {active.length === 0 && (
                <tr>
                  <td
                    className="px-4 py-8 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500"
                    colSpan={5}
                  >
                    no active members
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </section>

      <CreateUserModal onClose={() => setCreatingDirect(false)} open={creatingDirect} />
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={cn(
        'px-4 py-3 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-paper-500',
        align === 'right' ? 'text-right' : 'text-left'
      )}
    >
      {children}
    </th>
  );
}
