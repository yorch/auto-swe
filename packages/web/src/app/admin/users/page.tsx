'use client';

import type { UserSummary } from '@auto-swe/shared/types/api';
import { useEffect, useMemo, useState } from 'react';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { CreateUserModal } from '@/components/users/CreateUserModal';
import { InviteUserModal } from '@/components/users/InviteUserModal';
import { RoleSelectCell } from '@/components/users/RoleSelectCell';
import { useDataTableSort } from '@/hooks/useDataTableSort';
import { usePagedRows } from '@/hooks/usePagedRows';
import { useUpdateUser, useUsers } from '@/hooks/useUsers';
import { errMsg } from '@/lib/errors';
import { platformRoleLabel, roleChangeNeedsConfirm } from '@/lib/govLabels';
import { navLabel } from '@/lib/navigation';
import { cn, formatDate, plural } from '@/lib/utils';
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

const USER_SORT_KEYS = {
  email: (u: UserSummary) => u.email.toLowerCase(),
  joined: (u: UserSummary) => u.createdAt,
  role: (u: UserSummary) => u.role,
};

const ROLE_CONSEQUENCE: Record<Role, string> = {
  ADMIN: 'full access to every team and all platform settings',
  ENGINEER: 'access limited to their own teams and repositories',
  LEAD: 'access to the teams they lead, plus organization and baseline views',
};

export default function UsersPage() {
  const { data: users, isLoading, isError, isFetching, error: loadError, refetch } = useUsers();
  const updateUser = useUpdateUser();
  const [inviting, setInviting] = useState(false);
  const [inviteInfo, setInviteInfo] = useState<string | null>(null);
  const [creatingDirect, setCreatingDirect] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);
  const currentUserId = useAuthStore((s) => s.user?.sub ?? null);
  const [suspendTarget, setSuspendTarget] = useState<{ email: string; id: string } | null>(null);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'' | Role>('');
  const { onSortChange, sort, sortRows } = useDataTableSort<UserSummary>(USER_SORT_KEYS);

  // The invite notice is a one-off acknowledgement, not standing state.
  useEffect(() => {
    if (!inviteInfo) {
      return;
    }
    const id = setTimeout(() => setInviteInfo(null), 8000);
    return () => clearTimeout(id);
  }, [inviteInfo]);

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
  const pager = usePagedRows(sortRows(visible), 25, `${query}|${roleFilter}`);
  const header = (
    <PageHeader
      actions={
        <>
          <Button onClick={() => setCreatingDirect(true)} variant="secondary">
            Create user directly
          </Button>
          <Button onClick={() => setInviting(true)} variant="primary">
            <Icon name="plus" size={14} />
            Invite user
          </Button>
        </>
      }
      help={
        <p>
          People who sign up with GitHub, Google or an email link wait in the approval queue until
          an admin approves them. Invite sends a magic link and needs email delivery; Create user
          directly makes an active account at once, for service accounts or when email is not
          configured.
        </p>
      }
      subtitle="Manage who can sign in to the control plane."
      title={navLabel('/admin/users')}
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
              <SkeletonRows label="users" rows={5} />
            </Card>
          }
          onRetry={() => void refetch()}
        />
        <CreateUserModal onClose={() => setCreatingDirect(false)} open={creatingDirect} />
      </div>
    );
  }

  const applyRole = (id: string, role: Role) => updateUser.mutateAsync({ id, patch: { role } });

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

  const clearFilters = () => {
    setSearch('');
    setRoleFilter('');
  };

  return (
    <div className="space-y-6">
      {header}

      {inviteInfo && <Alert variant="success">{inviteInfo}</Alert>}

      {pending.length > 0 && (
        <Card className="fade-up stagger-2 border-warning-400/30">
          <CardHeader className="mb-1">
            <CardTitle>Awaiting approval</CardTitle>
            <Badge dot tone="warning">
              {pending.length} awaiting approval
            </Badge>
          </CardHeader>
          <p className="mb-2 text-sm text-paper-400">
            These accounts cannot sign in. New sign-ups wait here for approval, and members you
            suspend move here too; the directory does not record which is which.
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
                    {teamNames(u) && <> · {teamNames(u)}</>} · Joined {formatDate(u.createdAt)}
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
            className="h-8 w-full text-sm sm:w-40"
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
        <div className="-mx-4">
          <DataTable
            actions={(u) =>
              /* Suspending yourself would lock you out mid-session. */
              u.id === currentUserId ? (
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
              )
            }
            className="max-sm:px-4"
            columns={[
              {
                cell: (u) => (
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{u.email}</span>
                    {u.id === currentUserId && (
                      <Badge tone="accent" variant="outline">
                        You
                      </Badge>
                    )}
                  </span>
                ),
                header: 'Member',
                id: 'email',
                primary: true,
                secondary: (u) => <span className="truncate">{teamNames(u) || 'No team'}</span>,
                sortable: true,
              },
              {
                /* Changing your own role could lock you out mid-session. */
                cell: (u) =>
                  u.id === currentUserId ? (
                    <Badge title="You cannot change your own role" tone="accent" variant="outline">
                      {platformRoleLabel(u.role)}
                    </Badge>
                  ) : (
                    <RoleSelectCell
                      apply={(to) => applyRole(u.id, to as Role)}
                      ariaLabel={`Role for ${u.email}`}
                      confirm={(from, to) =>
                        roleChangeNeedsConfirm(from, to)
                          ? {
                              confirmLabel: to === 'ADMIN' ? 'Make admin' : 'Change role',
                              dangerous: to === 'ADMIN',
                              message: `${u.email} will go from ${platformRoleLabel(from)} to ${platformRoleLabel(to)}: ${ROLE_CONSEQUENCE[to as Role]}. The change applies immediately.`,
                              title: 'Change role?',
                            }
                          : null
                      }
                      options={ROLE_OPTIONS}
                      value={u.role}
                    />
                  ),
                header: 'Role',
                id: 'role',
                sortable: true,
              },
              {
                cell: (u) =>
                  u.slackId ? (
                    <span className="font-mono text-xs text-paper-300">{u.slackId}</span>
                  ) : (
                    <span className="text-xs text-paper-500">Not linked</span>
                  ),
                header: 'Slack',
                id: 'slack',
              },
              {
                cell: (u) => <span className="text-paper-400">{formatDate(u.createdAt)}</span>,
                header: 'Joined',
                id: 'joined',
                sortable: true,
              },
            ]}
            empty={
              filtering ? (
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
                  hint="Invite a teammate, or approve an account awaiting approval."
                  icon="users"
                  title="No active members"
                />
              )
            }
            getRowId={(u) => u.id}
            onSortChange={onSortChange}
            revealActions={false}
            rows={pager.pageRows}
            sort={sort}
          />
        </div>
        {pager.paged && (
          <div className="mt-4 border-t border-ink-600 pt-4">
            <Pagination
              hasNext={pager.hasNext}
              hasPrev={pager.hasPrev}
              onNext={pager.onNext}
              onPrev={pager.onPrev}
              rangeEnd={pager.rangeEnd}
              rangeStart={pager.rangeStart}
              total={pager.total}
            />
          </div>
        )}
      </Card>

      <CreateUserModal onClose={() => setCreatingDirect(false)} open={creatingDirect} />
      <InviteUserModal
        onClose={() => setInviting(false)}
        onInvited={(email) =>
          setInviteInfo(`Invite sent to ${email}. They will receive a magic-link email.`)
        }
        open={inviting}
      />
      <ConfirmModal
        confirmLabel="Suspend"
        dangerous
        message={`${suspendTarget?.email ?? 'This user'} can no longer sign in, and their active sessions and API tokens stop working immediately. Their team memberships are kept. They move to the Awaiting approval list, where you can approve them again later.`}
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
