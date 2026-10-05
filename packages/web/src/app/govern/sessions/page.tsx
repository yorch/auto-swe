'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  useAdminRevokeSession,
  useAdminRevokeUserSessions,
  useAdminSessions,
} from '@/hooks/useAdmin';
import { navLabel } from '@/lib/navigation';
import { formatDate, formatRelativeTime } from '@/lib/utils';

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
      chapter="§ Govern"
      subtitle="Every signed-in browser session. Revoking one signs that person out immediately; they sign in again to continue."
      title={navLabel('/govern/sessions')}
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
          label="sessions"
          loadingMessage="loading sessions…"
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

  return (
    <div className="space-y-8">
      {header}

      <section className="fade-up stagger-1">
        <SectionHeader hint={`${rows.length} active · newest first`} number="01" title="Sessions" />
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Select
            aria-label="Filter by user"
            className="w-64 max-w-full"
            onChange={(v) => {
              setUserFilter(v);
              setNotice(null);
            }}
            options={[
              { label: 'All users', value: '' },
              ...users.map(([id, email]) => ({ label: email, value: id })),
            ]}
            value={userFilter}
          />
          {userFilter && (
            <Button
              disabled={revokableForUser === 0 || revokeUser.isPending}
              onClick={() => setRevokeAllOpen(true)}
              size="sm"
              variant="danger"
            >
              Revoke all for {filteredEmail ?? 'this user'}
            </Button>
          )}
        </div>
        {notice && (
          <Alert className="mb-3" variant="success">
            {notice}
          </Alert>
        )}
        <Card className="overflow-x-auto p-0" variant="inset">
          <Table>
            <THead>
              <Th>User</Th>
              <Th>Started</Th>
              <Th>Last active</Th>
              <Th>Expires</Th>
              <Th>Device</Th>
              <Th>Session</Th>
              <Th align="right">Actions</Th>
            </THead>
            <tbody>
              {rows.map((s) => (
                <TRow key={s.id}>
                  <Td className="px-4 py-3 text-sm text-paper-100">
                    {s.user.email}
                    {s.current && (
                      <Badge className="ml-2" tone="ember" variant="outline">
                        This session
                      </Badge>
                    )}
                  </Td>
                  <Td className="px-4 py-3 font-mono text-[11px] text-paper-400">
                    {formatDate(s.createdAt)}
                  </Td>
                  <Td className="px-4 py-3 font-mono text-[11px] text-paper-400">
                    {formatRelativeTime(s.updatedAt)}
                  </Td>
                  <Td className="px-4 py-3 font-mono text-[11px] text-paper-400">
                    {formatRelativeTime(s.expiresAt)}
                  </Td>
                  <Td className="px-4 py-3 font-mono text-[10px] text-paper-500">
                    {s.ipAddress ?? '—'}
                    {s.userAgent && (
                      <span className="block max-w-[220px] truncate text-paper-600">
                        {s.userAgent}
                      </span>
                    )}
                  </Td>
                  <Td className="px-4 py-3 font-mono text-[10px] text-paper-500">{s.token}</Td>
                  <Td align="right" className="px-4 py-3">
                    <Button
                      onClick={() => setRevokeTarget({ email: s.user.email, id: s.id })}
                      size="sm"
                      title={s.current ? 'This is the session you are using now' : undefined}
                      variant="danger"
                    >
                      {s.current ? 'Revoke (you)' : 'Revoke'}
                    </Button>
                  </Td>
                </TRow>
              ))}
              {rows.length === 0 && (
                <TableStatusRow colSpan={7}>
                  <EmptyState
                    title={userFilter ? 'No active sessions for this user.' : 'No active sessions'}
                  />
                </TableStatusRow>
              )}
            </tbody>
          </Table>
        </Card>
      </section>

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
