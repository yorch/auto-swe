'use client';

import type { UserSummary } from '@auto-swe/shared/types/api';
import { useMemo, useState } from 'react';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { CreateUserModal } from '@/components/users/CreateUserModal';
import { useInviteUser, useUpdateUser, useUsers } from '@/hooks/useUsers';
import { errMsg } from '@/lib/errors';
import { platformRoleLabel, roleChangeNeedsConfirm } from '@/lib/govLabels';
import { navLabel } from '@/lib/navigation';
import { cn, plural } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

type Role = 'ADMIN' | 'LEAD' | 'ENGINEER';

const ROLE_OPTIONS: { label: string; value: Role }[] = [
  { label: platformRoleLabel('ENGINEER'), value: 'ENGINEER' },
  { label: platformRoleLabel('LEAD'), value: 'LEAD' },
  { label: platformRoleLabel('ADMIN'), value: 'ADMIN' },
];

/** A user's team names, comma-separated; empty when they belong to none. */
function teamNames(u: UserSummary): string {
  return (u.memberships ?? [])
    .map((m) => m.team?.name)
    .filter(Boolean)
    .join(', ');
}

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
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'' | Role>('');

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
      actions={
        <Button onClick={() => setCreatingDirect(true)} variant="secondary">
          <Icon name="plus" size={14} />
          Create user directly
        </Button>
      }
      subtitle="Manage who can sign in to the control plane. People who sign up with GitHub, Google or an email link wait in the pending queue until an admin approves them."
      title={navLabel('/govern/users')}
    />
  );

  if (isLoading || isError) {
    return (
      <div className="space-y-6">
        {header}
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="users"
          loading={
            <Card>
              <SkeletonRows rows={5} />
            </Card>
          }
          onRetry={() => void refetch()}
        />
        <CreateUserModal onClose={() => setCreatingDirect(false)} open={creatingDirect} />
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

  const query = search.trim().toLowerCase();
  const filtering = query !== '' || roleFilter !== '';
  const visible = active.filter(
    (u) =>
      (!roleFilter || u.role === roleFilter) &&
      (!query ||
        u.email.toLowerCase().includes(query) ||
        (u.slackId ?? '').toLowerCase().includes(query) ||
        teamNames(u).toLowerCase().includes(query))
  );
  const clearFilters = () => {
    setSearch('');
    setRoleFilter('');
  };

  return (
    <div className="space-y-6">
      {header}

      {/* Invite by email — admin sends a magic-link to the address. The
          invitee lands pre-active + pre-membered to the default team.
          For service accounts (or when SMTP/Resend isn't configured),
          "Create directly" pops the CreateUserModal which posts to
          POST /api/v1/users and reveals an auto-generated password once. */}
      <Card className="fade-up stagger-1">
        <CardHeader className="mb-1">
          <CardTitle>Invite a teammate</CardTitle>
        </CardHeader>
        <p className="mb-4 text-[13px] text-paper-400">
          They get a magic-link email and join the default team, already approved.
        </p>
        {inviteError && (
          <Alert className="mb-4" variant="error">
            {inviteError}
          </Alert>
        )}
        {inviteInfo && (
          <Alert className="mb-4" variant="success">
            {inviteInfo}
          </Alert>
        )}
        <form
          className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto]"
          onSubmit={handleInvite}
        >
          <Input
            label="Email"
            name="invite-email"
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="teammate@workshop.dev"
            required
            type="email"
            value={inviteEmail}
          />
          <Select
            id="invite-role"
            label="Role"
            onChange={(v) => setInviteRole(v as Role)}
            options={ROLE_OPTIONS}
            value={inviteRole}
          />
          <Button className="h-9" disabled={inviteUser.isPending} type="submit" variant="primary">
            {inviteUser.isPending ? 'Sending…' : 'Send invite'}
          </Button>
        </form>
      </Card>

      {pending.length > 0 && (
        <Card className="fade-up stagger-2 border-amber-400/30">
          <CardHeader className="mb-1">
            <CardTitle>Pending sign-ups</CardTitle>
            <Badge dot tone="amber">
              {pending.length} awaiting approval
            </Badge>
          </CardHeader>
          <p className="mb-2 text-[13px] text-paper-400">
            These people signed up but cannot sign in until you approve them.
          </p>
          {approveError && (
            <Alert className="mb-3" variant="error">
              {approveError}
            </Alert>
          )}
          <ul className="divide-y divide-ink-600">
            {pending.map((u) => (
              <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={u.id}>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-paper-100">{u.email}</div>
                  <div className="mt-0.5 text-xs text-paper-500">
                    {platformRoleLabel(u.role)}
                    {teamNames(u) && <> · {teamNames(u)}</>}
                  </div>
                </div>
                <Button
                  disabled={approvingId !== null}
                  onClick={() => handleApprove(u.id)}
                  size="sm"
                  variant="primary"
                >
                  <Icon name="check" size={14} />
                  {approvingId === u.id ? 'Approving…' : 'Approve'}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className={cn('fade-up p-4 sm:p-6', pending.length > 0 ? 'stagger-3' : 'stagger-2')}>
        <CardHeader>
          <CardTitle>Active members</CardTitle>
        </CardHeader>
        <Toolbar
          end={
            <span className="text-xs text-paper-500 tabular-nums">
              {filtering
                ? `${visible.length} of ${plural(active.length, 'member')}`
                : plural(active.length, 'member')}
            </span>
          }
        >
          <SearchInput
            label="Search members"
            onChange={setSearch}
            placeholder="Search members…"
            value={search}
          />
          <Select
            aria-label="Filter by role"
            className="h-8 w-full text-[13px] sm:w-40"
            onChange={(v) => setRoleFilter(v as '' | Role)}
            options={[{ label: 'All roles', value: '' }, ...ROLE_OPTIONS]}
            value={roleFilter}
          />
          {filtering && (
            <Button onClick={clearFilters} size="sm" variant="ghost">
              Clear filters
            </Button>
          )}
        </Toolbar>
        {roleError && (
          <Alert className="mb-3" variant="error">
            {roleError}
          </Alert>
        )}
        <Table stacked>
          <THead>
            <Th className="pl-0" variant="plain">
              Member
            </Th>
            <Th variant="plain">Role</Th>
            <Th variant="plain">Slack</Th>
            <Th className="pr-0" variant="plain">
              <span className="sr-only">Actions</span>
            </Th>
          </THead>
          <tbody>
            {visible.map((u) => (
              <TRow hover key={u.id}>
                <Td className="py-3 pr-4" primary>
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium text-paper-100">{u.email}</span>
                    {u.id === currentUserId && (
                      <Badge tone="ember" variant="outline">
                        You
                      </Badge>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs font-normal text-paper-500">
                    {teamNames(u) || 'No team'}
                  </div>
                </Td>
                <Td className="px-4 py-3" label="Role">
                  {/* Changing your own role could lock you out mid-session. */}
                  {u.id === currentUserId ? (
                    <Badge title="You cannot change your own role" tone="ember" variant="outline">
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
                <Td className="px-4 py-3" label="Slack">
                  {u.slackId ? (
                    <span className="font-mono text-xs text-paper-300">{u.slackId}</span>
                  ) : (
                    <span className="text-xs text-paper-500">Not linked</span>
                  )}
                </Td>
                <Td align="right" className="py-3 pl-4">
                  {/* Suspending yourself would lock you out mid-session. */}
                  {u.id === currentUserId ? (
                    <span className="sr-only">Your own account cannot be suspended</span>
                  ) : (
                    <ActionMenu
                      items={[
                        {
                          icon: 'lock',
                          id: 'suspend',
                          label: 'Suspend',
                          onAction: () => setSuspendTarget({ email: u.email, id: u.id }),
                          tone: 'danger',
                        },
                      ]}
                      label={`More actions for ${u.email}`}
                    />
                  )}
                </Td>
              </TRow>
            ))}
            {visible.length === 0 && (
              <TableStatusRow colSpan={4}>
                {filtering ? (
                  <EmptyState
                    action={
                      <Button onClick={clearFilters} size="sm">
                        Clear filters
                      </Button>
                    }
                    hint="Try a different search or role."
                    icon="search"
                    title="No members match these filters"
                  />
                ) : (
                  <EmptyState
                    hint="Invite a teammate above, or approve a pending sign-up."
                    icon="users"
                    title="No active members"
                  />
                )}
              </TableStatusRow>
            )}
          </tbody>
        </Table>
      </Card>

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
