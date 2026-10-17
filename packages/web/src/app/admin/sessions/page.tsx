'use client';

import { useState } from 'react';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Select } from '@/components/ui/Select';
import { Toolbar } from '@/components/ui/Toolbar';
import {
  useAdminRevokeSession,
  useAdminRevokeUserSessions,
  useAdminSessions,
} from '@/hooks/useAdmin';
import { navLabel } from '@/lib/navigation';
import { describeUserAgent } from '@/lib/userAgent';
import { plural } from '@/lib/utils';

export default function GovernSessionsPage() {
  const {
    data: sessions,
    isLoading,
    isError,
    isFetching,
    refetch,
    error: loadError,
  } = useAdminSessions();
  const revoke = useAdminRevokeSession();
  const revokeUser = useAdminRevokeUserSessions();
  const [revokeTarget, setRevokeTarget] = useState<{ email: string; id: string } | null>(null);
  const [userFilter, setUserFilter] = useState('');
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const header = (
    <PageHeader
      help={<p>Revoking one signs that person out immediately; they sign in again to continue.</p>}
      subtitle="Every signed-in browser session."
      title={navLabel('/admin/sessions')}
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
          label="sessions"
          loading={
            <Card>
              <SkeletonRows label="sessions" rows={5} />
            </Card>
          }
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  const all = sessions ?? [];
  const users = [...new Map(all.map((s) => [s.user.id, s.user.email])).entries()].sort((a, b) =>
    a[1].localeCompare(b[1])
  );
  const rows = userFilter ? all.filter((s) => s.user.id === userFilter) : all;
  const filteredEmail = users.find(([id]) => id === userFilter)?.[1];
  // The caller's own session is kept by a bulk revoke, so the count excludes it.
  const revokableForUser = rows.filter((s) => !s.current).length;

  const selectUser = (id: string) => {
    setUserFilter(id);
    setNotice(null);
  };

  return (
    <div className="space-y-6">
      {header}

      {notice && <Alert variant="success">{notice}</Alert>}

      <Card className="fade-up stagger-1 p-4 sm:p-6">
        <Toolbar
          end={
            <span className="text-xs text-paper-500 tabular-nums">
              {userFilter
                ? `${rows.length} of ${plural(all.length, 'active session')}`
                : `${plural(all.length, 'active session')} · newest first`}
            </span>
          }
        >
          <Select
            aria-label="Filter by user"
            className="h-8 w-full text-sm sm:w-64"
            onChange={selectUser}
            options={[
              { label: 'All users', value: '' },
              ...users.map(([id, email]) => ({ label: email, value: id })),
            ]}
            value={userFilter}
          />
          {userFilter && (
            <>
              <Button onClick={() => selectUser('')} size="sm" variant="ghost">
                Show everyone
              </Button>
              <Button
                disabled={revokableForUser === 0 || revokeUser.isPending}
                onClick={() => setRevokeAllOpen(true)}
                size="sm"
                variant="danger"
              >
                Revoke all for {filteredEmail ?? 'this user'}
              </Button>
            </>
          )}
        </Toolbar>
        <div className="-mx-4">
          <DataTable
            actions={(s) => (
              <ActionMenu
                items={[
                  ...(userFilter
                    ? []
                    : [
                        {
                          icon: 'filter' as const,
                          id: 'filter',
                          label: 'Only this user',
                          onAction: () => selectUser(s.user.id),
                        },
                      ]),
                  {
                    icon: 'lock',
                    id: 'revoke',
                    label: s.current ? 'Revoke (signs you out)' : 'Revoke session',
                    onAction: () => setRevokeTarget({ email: s.user.email, id: s.id }),
                    tone: 'danger',
                  },
                ]}
                label={`Actions for ${s.user.email}'s session`}
              />
            )}
            className="max-sm:px-4"
            columns={[
              {
                cell: (s) => (
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate">{s.user.email}</span>
                    {s.current && (
                      <Badge dot tone="accent" variant="outline">
                        This session
                      </Badge>
                    )}
                  </span>
                ),
                header: 'User and device',
                id: 'user',
                primary: true,
                secondary: (s) => (
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Icon className="shrink-0" name="monitor" size={12} />
                    <span className="truncate" title={s.userAgent ?? undefined}>
                      {s.userAgent ? describeUserAgent(s.userAgent) : 'Unknown device'}
                    </span>
                    {s.ipAddress && (
                      <>
                        <span aria-hidden>·</span>
                        <span className="font-mono">{s.ipAddress}</span>
                      </>
                    )}
                  </div>
                ),
              },
              {
                cell: (s) => (
                  <span className="text-sm text-paper-300">
                    <RelativeTime value={s.updatedAt} />
                  </span>
                ),
                header: 'Last active',
                id: 'lastActive',
              },
              {
                cell: (s) => (
                  <span className="text-sm text-paper-400">
                    <RelativeTime value={s.createdAt} />
                  </span>
                ),
                header: 'Started',
                id: 'started',
              },
              {
                cell: (s) => (
                  <span className="text-sm text-paper-400">
                    <RelativeTime value={s.expiresAt} />
                  </span>
                ),
                header: 'Expires',
                id: 'expires',
              },
              {
                cell: (s) => (
                  <span
                    className="block max-w-[10rem] truncate font-mono text-xs text-paper-500"
                    title={s.token}
                  >
                    {s.token}
                  </span>
                ),
                header: 'Session ID',
                id: 'sessionId',
              },
            ]}
            empty={
              <EmptyState
                action={
                  userFilter ? (
                    <Button onClick={() => selectUser('')} size="sm">
                      Show everyone
                    </Button>
                  ) : undefined
                }
                hint={
                  userFilter
                    ? 'This user is signed out everywhere.'
                    : 'Sessions appear here when people sign in to the dashboard.'
                }
                icon="monitor"
                title={userFilter ? 'No active sessions for this user' : 'No active sessions'}
              />
            }
            getRowId={(s) => s.id}
            revealActions={false}
            rows={rows}
          />
        </div>
      </Card>

      <ConfirmModal
        confirmLabel="Revoke"
        dangerous
        message={`${revokeTarget?.email ?? 'The user'} is signed out of this session immediately and must sign in again. This cannot be undone.`}
        onClose={() => setRevokeTarget(null)}
        onConfirm={async () => {
          if (revokeTarget) {
            await revoke.mutateAsync(revokeTarget.id);
          }
        }}
        open={revokeTarget !== null}
        title="Revoke session?"
      />

      <ConfirmModal
        confirmLabel="Revoke all"
        dangerous
        message={`Sign ${filteredEmail ?? 'this user'} out of ${revokableForUser} session${revokableForUser === 1 ? '' : 's'} immediately. They must sign in again on each device. Your own session is kept.`}
        onClose={() => setRevokeAllOpen(false)}
        onConfirm={async () => {
          const result = await revokeUser.mutateAsync(userFilter);
          setNotice(
            `Revoked ${result.revoked} session${result.revoked === 1 ? '' : 's'} for ${filteredEmail ?? 'the user'}.`
          );
        }}
        open={revokeAllOpen}
        title="Revoke all sessions?"
      />
    </div>
  );
}
