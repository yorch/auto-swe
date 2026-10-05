'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useAdminRevokeSession, useAdminSessions } from '@/hooks/useAdmin';
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
  const [revokeTarget, setRevokeTarget] = useState<{ email: string; id: string } | null>(null);

  if (isLoading || isError) {
    return (
      <QueryBoundary
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="sessions"
        loadingMessage="loading sessions…"
        onRetry={() => void refetch()}
      />
    );
  }

  const rows = sessions ?? [];

  return (
    <div className="space-y-8">
      <PageHeader
        chapter="§ Govern"
        subtitle="Every active browser session (better-auth). Revoke immediately locks the cookie out and clears the in-memory auth cache."
        title="Active sessions"
      />

      <section className="fade-up stagger-1">
        <SectionHeader hint={`${rows.length} active · newest first`} number="01" title="Sessions" />
        <Card className="overflow-hidden p-0" variant="inset">
          <Table>
            <THead>
              <Th>User</Th>
              <Th>Started</Th>
              <Th>Last active</Th>
              <Th>Expires</Th>
              <Th>Source</Th>
              <Th>Token</Th>
              <Th align="right">Actions</Th>
            </THead>
            <tbody>
              {rows.map((s) => (
                <TRow key={s.id}>
                  <Td className="px-4 py-3 text-sm text-paper-100">{s.user.email}</Td>
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
                      variant="danger"
                    >
                      Revoke
                    </Button>
                  </Td>
                </TRow>
              ))}
              {rows.length === 0 && (
                <TableStatusRow colSpan={7}>
                  <EmptyState title="No active sessions" />
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
    </div>
  );
}
