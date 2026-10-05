'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useAdminRevokeToken, useAdminTokens } from '@/hooks/useAdmin';
import { errMsg } from '@/lib/errors';
import { navLabel } from '@/lib/navigation';
import { formatDate, formatRelativeTime } from '@/lib/utils';

function StatusChip({ status }: { status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' }) {
  return (
    <Badge
      className={status === 'REVOKED' ? 'line-through' : undefined}
      tone={status === 'ACTIVE' ? 'moss' : status === 'EXPIRED' ? 'amber' : 'muted'}
      uppercase
      variant="text"
    >
      {STATUS_LABELS[status]}
    </Badge>
  );
}

const PAGE_SIZE = 25;

type TokenStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

const STATUS_LABELS: Record<TokenStatus, string> = {
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  REVOKED: 'Revoked',
};

export default function GovernAccessTokensPage() {
  const {
    data: tokens,
    isLoading,
    isError,
    isFetching,
    refetch,
    error: loadError,
  } = useAdminTokens();
  const revokeToken = useAdminRevokeToken();
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);
  const [statusFilter, setStatusFilter] = useState<'' | TokenStatus>('');
  const [userFilter, setUserFilter] = useState('');
  const [page, setPage] = useState(0);

  // Awaited so ConfirmModal keeps the dialog open and shows a failed revoke.
  const confirmRevoke = async () => {
    if (revokeTarget) {
      await revokeToken.mutateAsync(revokeTarget.id);
    }
  };

  const now = Date.now();
  const statusOf = (t: NonNullable<typeof tokens>[number]): TokenStatus =>
    t.revokedAt
      ? 'REVOKED'
      : t.expiresAt && new Date(t.expiresAt).getTime() < now
        ? 'EXPIRED'
        : 'ACTIVE';
  const all = tokens ?? [];
  const activeCount = all.filter((t) => statusOf(t) === 'ACTIVE').length;
  const userOptions = [...new Set(all.map((t) => t.user.email))].sort();
  const rows = all.filter(
    (t) =>
      (!statusFilter || statusOf(t) === statusFilter) &&
      (!userFilter || t.user.email === userFilter)
  );
  const pageStart = Math.min(page * PAGE_SIZE, Math.max(0, rows.length - 1));
  const pageRows = rows.slice(pageStart, pageStart + PAGE_SIZE);

  const header = (
    <PageHeader
      chapter="§ Govern"
      subtitle="Platform admins can view and revoke any user's personal access token. Token values are never stored — only the non-secret prefix is shown."
      title={navLabel('/govern/api-tokens')}
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
          label="tokens"
          loadingMessage="loading tokens…"
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {header}

      <section className="fade-up stagger-1 space-y-3">
        <SectionHeader
          hint={`${activeCount} active / ${all.length} total · newest first`}
          number="01"
          title="All tokens"
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select
            aria-label="Filter by status"
            onChange={(v) => {
              setStatusFilter(v as '' | TokenStatus);
              setPage(0);
            }}
            options={[
              { label: 'All statuses', value: '' },
              ...(Object.keys(STATUS_LABELS) as TokenStatus[]).map((v) => ({
                label: STATUS_LABELS[v],
                value: v,
              })),
            ]}
            value={statusFilter}
          />
          <Select
            aria-label="Filter by user"
            onChange={(v) => {
              setUserFilter(v);
              setPage(0);
            }}
            options={[
              { label: 'All users', value: '' },
              ...userOptions.map((e) => ({ label: e, value: e })),
            ]}
            value={userFilter}
          />
        </div>
        {revokeToken.isError && (
          <Alert>Revoke failed: {errMsg(revokeToken.error, 'unknown error')}</Alert>
        )}

        <Card className="overflow-x-auto p-0" variant="inset">
          <Table>
            <THead>
              <Th>User</Th>
              <Th>Name</Th>
              <Th>Prefix</Th>
              <Th>Created</Th>
              <Th>Last used</Th>
              <Th>Expires</Th>
              <Th>Status</Th>
              <Th align="right">Actions</Th>
            </THead>
            <tbody>
              {pageRows.map((t) => {
                const status = statusOf(t);
                return (
                  <TRow key={t.id}>
                    <Td className="px-4 py-3 text-sm text-paper-100">{t.user.email}</Td>
                    <Td className="px-4 py-3 text-sm text-paper-200">{t.name}</Td>
                    <Td className="px-4 py-3 font-mono text-[10px] text-paper-400">{t.prefix}</Td>
                    <Td className="px-4 py-3 font-mono text-[11px] text-paper-400">
                      {formatRelativeTime(t.createdAt)}
                    </Td>
                    <Td className="px-4 py-3 font-mono text-[11px] text-paper-400">
                      {t.lastUsedAt ? formatRelativeTime(t.lastUsedAt) : '—'}
                    </Td>
                    <Td className="px-4 py-3 font-mono text-[11px] text-paper-400">
                      {t.expiresAt ? formatDate(t.expiresAt) : 'never'}
                    </Td>
                    <Td className="px-4 py-3">
                      <StatusChip status={status} />
                    </Td>
                    <Td className="px-4 py-3 text-right">
                      {!t.revokedAt && (
                        <Button
                          disabled={revokeToken.isPending}
                          onClick={() => setRevokeTarget({ id: t.id, name: t.name })}
                          size="sm"
                          variant="danger"
                        >
                          Revoke
                        </Button>
                      )}
                    </Td>
                  </TRow>
                );
              })}
              {rows.length === 0 && (
                <TableStatusRow colSpan={8}>
                  <EmptyState
                    title={
                      all.length === 0 ? 'No tokens issued yet' : 'No tokens match these filters.'
                    }
                  />
                </TableStatusRow>
              )}
            </tbody>
          </Table>
        </Card>
        {rows.length > PAGE_SIZE && (
          <Pagination
            hasNext={pageStart + PAGE_SIZE < rows.length}
            hasPrev={pageStart > 0}
            onNext={() => setPage(page + 1)}
            onPrev={() => setPage(Math.max(0, page - 1))}
            rangeEnd={Math.min(pageStart + PAGE_SIZE, rows.length)}
            rangeStart={pageStart + 1}
            total={rows.length}
          />
        )}
      </section>

      <ConfirmModal
        confirmLabel="Revoke"
        dangerous
        message={`Revoke token "${revokeTarget?.name}"? This cannot be undone.`}
        onClose={() => setRevokeTarget(null)}
        onConfirm={confirmRevoke}
        open={revokeTarget !== null}
        title="Revoke access token"
      />
    </div>
  );
}
