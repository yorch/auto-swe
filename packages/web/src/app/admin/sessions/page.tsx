'use client';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useAdminRevokeSession, useAdminSessions } from '@/hooks/useAdmin';
import { formatDate, formatRelativeTime } from '@/lib/utils';

export default function AdminSessionsPage() {
  const { data: sessions, isLoading, isError, error: loadError } = useAdminSessions();
  const revoke = useAdminRevokeSession();

  if (isLoading || isError) {
    return (
      <QueryBoundary
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="sessions"
        loadingMessage="loading sessions…"
      />
    );
  }

  const rows = sessions ?? [];

  return (
    <div className="space-y-10">
      <div className="fade-up">
        <PageHeader
          chapter={`§ Admin · Sessions · ${rows.length} active`}
          subtitle="Every active browser session (better-auth). Revoke immediately locks the cookie out and clears the in-memory auth cache."
          title="Active sessions."
        />
      </div>

      <section className="fade-up stagger-1">
        <SectionHeader hint="newest first" number="01" title="Sessions" />
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
                  <Td className="px-4 py-3 text-right">
                    <Button
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(s.id)}
                      size="sm"
                      variant="danger"
                    >
                      Revoke
                    </Button>
                  </Td>
                </TRow>
              ))}
              {rows.length === 0 && (
                <TRow>
                  <Td
                    className="px-4 py-8 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500"
                    colSpan={7}
                  >
                    no active sessions
                  </Td>
                </TRow>
              )}
            </tbody>
          </Table>
        </Card>
      </section>
    </div>
  );
}
