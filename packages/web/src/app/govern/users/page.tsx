'use client';

import { useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { CreateUserModal } from '@/components/users/CreateUserModal';
import { useInviteUser, useUpdateUser, useUsers } from '@/hooks/useUsers';
import { errMsg } from '@/lib/errors';
import { platformRoleLabel, roleChangeNeedsConfirm } from '@/lib/govLabels';
import { navLabel } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

type Role = 'ADMIN' | 'LEAD' | 'ENGINEER';

const ROLE_OPTIONS: { label: string; value: Role }[] = [
  { label: platformRoleLabel('ENGINEER'), value: 'ENGINEER' },
  { label: platformRoleLabel('LEAD'), value: 'LEAD' },
  { label: platformRoleLabel('ADMIN'), value: 'ADMIN' },
];

const ROLE_CONSEQUENCE: Record<Role, string> = {
  ADMIN: 'full access to every team and all platform settings',
  ENGINEER: 'access limited to their own teams and repositories',
  LEAD: 'access to the teams they lead, plus organization and baseline views',
};

export default function UsersPage() {
  const { data: users, isLoading, isError, isFetching, error: loadError, refetch } = useUsers();
  const updateUser = useUpdateUser();
  const inviteUser = useInviteUser();
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('ENGINEER');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteInfo, setInviteInfo] = useState<string | null>(null);
  const [creatingDirect, setCreatingDirect] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);
  const currentUserId = useAuthStore((s) => s.user?.sub ?? null);
  const [roleChange, setRoleChange] = useState<{
    email: string;
    from: Role;
    id: string;
    to: Role;
  } | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [suspendTarget, setSuspendTarget] = useState<{ email: string; id: string } | null>(null);

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

  const header = (
    <PageHeader
      chapter="§ Govern"
      subtitle="Manage who can sign in to the control plane. People who sign up with GitHub, Google or an email link wait in the pending queue until an admin approves them."
      title={navLabel('/govern/users')}
    />
  );

  if (isLoading || isError) {
    return (
      <div className="space-y-8">
        {header}
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="users"
          loadingMessage="loading users…"
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  const applyRole = async (id: string, role: Role) => {
    setRoleError(null);
    try {
      await updateUser.mutateAsync({ id, patch: { role } });
    } catch (err) {
      setRoleError(errMsg(err, 'Could not change the role'));
      throw err;
    }
  };

  const handleApprove = async (id: string) => {
    setApproveError(null);
    setApprovingId(id);
    try {
      await updateUser.mutateAsync({ id, patch: { isActive: true } });
    } catch (err) {
      setApproveError(errMsg(err, 'approve failed'));
    } finally {
      setApprovingId(null);
    }
  };

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
      setInviteError(errMsg(err, 'invite failed'));
    }
  };

  return (
    <div className="space-y-8">
      {header}

      {/* Invite by email — admin sends a magic-link to the address. The
          invitee lands pre-active + pre-membered to the default team.
          For service accounts (or when SMTP/Resend isn't configured),
          "+ Create directly" pops the CreateUserModal which posts to
          POST /api/v1/users and reveals an auto-generated password once. */}
      <section className="fade-up stagger-1">
        <SectionHeader
          actions={
            <Button onClick={() => setCreatingDirect(true)} size="sm" variant="secondary">
              Create directly
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
              <Select
                className="w-auto"
                id="invite-role"
                label="Role"
                onChange={(v) => setInviteRole(v as Role)}
                options={ROLE_OPTIONS}
                value={inviteRole}
              />
            </div>
            <Button disabled={inviteUser.isPending} size="md" type="submit" variant="primary">
              {inviteUser.isPending ? 'Sending…' : 'Send invite'}
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
            {approveError && (
              <Alert className="mb-3" variant="error">
                {approveError}
              </Alert>
            )}
            <ul className="divide-y divide-ink-600">
              {pending.map((u) => (
                <li className="flex items-center justify-between py-3" key={u.id}>
                  <div className="flex items-center gap-3">
                    <Badge dot tone="amber" uppercase variant="text">
                      pending
                    </Badge>
                    <div>
                      <div className="text-sm text-paper-100">{u.email}</div>
                      <div className="font-mono text-[11px] text-paper-500">
                        Role: {platformRoleLabel(u.role)}
                        {u.memberships && u.memberships.length > 0 && (
                          <>
                            {' · Teams: '}
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
                    disabled={approvingId !== null}
                    onClick={() => handleApprove(u.id)}
                    size="sm"
                    variant="primary"
                  >
                    {approvingId === u.id ? 'Approving…' : 'Approve'}
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
        {roleError && (
          <Alert className="mb-3" variant="error">
            {roleError}
          </Alert>
        )}
        <Card className="overflow-x-auto p-0" variant="inset">
          <Table stacked>
            <THead>
              <Th>Email</Th>
              <Th>Role</Th>
              <Th>Slack</Th>
              <Th>Teams</Th>
              <Th align="right">Actions</Th>
            </THead>
            <tbody>
              {active.map((u) => (
                <TRow key={u.id}>
                  <Td className="px-4 py-3 text-sm text-paper-100" primary>
                    {u.email}
                  </Td>
                  <Td className="px-4 py-3" label="Role">
                    {/* Changing your own role could lock you out mid-session. */}
                    {u.id === currentUserId ? (
                      <Badge tone="ember" uppercase variant="outline">
                        {platformRoleLabel(u.role)}
                      </Badge>
                    ) : (
                      <Select
                        aria-label={`Role for ${u.email}`}
                        className="w-32"
                        compact
                        onChange={(v) => {
                          const to = v as Role;
                          const from = u.role as Role;
                          if (to === from) {
                            return;
                          }
                          if (roleChangeNeedsConfirm(from, to)) {
                            setRoleChange({ email: u.email, from, id: u.id, to });
                          } else {
                            void applyRole(u.id, to).catch(() => undefined);
                          }
                        }}
                        options={ROLE_OPTIONS}
                        value={u.role}
                      />
                    )}
                  </Td>
                  <Td className="px-4 py-3 font-mono text-xs text-paper-400" label="Slack">
                    {u.slackId ?? <span className="text-paper-500">—</span>}
                  </Td>
                  <Td className="px-4 py-3 font-mono text-xs text-paper-400" label="Teams">
                    {(u.memberships ?? [])
                      .map((m) => m.team?.name)
                      .filter(Boolean)
                      .join(', ') || <span className="text-paper-500">—</span>}
                  </Td>
                  <Td className="px-4 py-3 text-right">
                    {/* Suspending yourself would lock you out mid-session. */}
                    {u.id === currentUserId ? (
                      <span className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
                        you
                      </span>
                    ) : (
                      <Button
                        onClick={() => setSuspendTarget({ email: u.email, id: u.id })}
                        size="sm"
                        variant="danger"
                      >
                        Suspend
                      </Button>
                    )}
                  </Td>
                </TRow>
              ))}
              {active.length === 0 && (
                <TableStatusRow colSpan={5}>
                  <EmptyState title="No active members" />
                </TableStatusRow>
              )}
            </tbody>
          </Table>
        </Card>
      </section>

      <CreateUserModal onClose={() => setCreatingDirect(false)} open={creatingDirect} />
      <ConfirmModal
        confirmLabel={roleChange?.to === 'ADMIN' ? 'Make admin' : 'Change role'}
        dangerous={roleChange?.to === 'ADMIN'}
        message={
          roleChange
            ? `${roleChange.email} will go from ${platformRoleLabel(roleChange.from)} to ${platformRoleLabel(roleChange.to)}: ${ROLE_CONSEQUENCE[roleChange.to]}. The change applies immediately.`
            : ''
        }
        onClose={() => setRoleChange(null)}
        onConfirm={async () => {
          if (roleChange) {
            await applyRole(roleChange.id, roleChange.to);
          }
        }}
        open={roleChange !== null}
        title="Change role?"
      />
      <ConfirmModal
        confirmLabel="Suspend"
        dangerous
        message={`${suspendTarget?.email ?? 'This user'} will no longer be able to sign in and moves back to the pending queue. You can approve them again later.`}
        onClose={() => setSuspendTarget(null)}
        onConfirm={async () => {
          if (suspendTarget) {
            await updateUser.mutateAsync({ id: suspendTarget.id, patch: { isActive: false } });
          }
        }}
        open={suspendTarget !== null}
        title="Suspend user?"
      />
    </div>
  );
}
