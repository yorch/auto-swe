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
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useAdminPruneShellAudit, useAdminRevokeToken, useAdminTokens } from '@/hooks/useAdmin';
import { errMsg } from '@/lib/errors';
import { formatDate, formatRelativeTime } from '@/lib/utils';

function StatusChip({ status }: { status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' }) {
  return (
    <Badge
      className={status === 'REVOKED' ? 'line-through' : undefined}
      tone={status === 'ACTIVE' ? 'moss' : status === 'EXPIRED' ? 'amber' : 'muted'}
      uppercase
      variant="text"
    >
      {status}
    </Badge>
  );
}

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
  const pruneAudit = useAdminPruneShellAudit(90);
  const [pruneResult, setPruneResult] = useState<{ deleted: number } | null>(null);
  const [pruneError, setPruneError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);
  const [pruneConfirmOpen, setPruneConfirmOpen] = useState(false);

  // Awaited so ConfirmModal keeps the dialog open and shows a failed revoke.
  const confirmRevoke = async () => {
    if (revokeTarget) {
      await revokeToken.mutateAsync(revokeTarget.id);
    }
  };

  const handlePrune = async () => {
    setPruneError(null);
    setPruneResult(null);
    try {
      const res = (await pruneAudit.mutateAsync()) as { data: { deleted: number } };
      setPruneResult(res.data);
    } catch (err) {
      setPruneError(errMsg(err, 'Prune failed'));
    }
  };

  const now = Date.now();
  const rows = tokens ?? [];
  const activeCount = rows.filter(
    (t) => !t.revokedAt && !(t.expiresAt && new Date(t.expiresAt).getTime() < now)
  ).length;

  if (isLoading || isError) {
    return (
      <QueryBoundary
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="tokens"
        loadingMessage="loading tokens…"
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        chapter="§ Govern"
        subtitle="Platform admins can view and revoke any user's personal access token. Plaintexts are never stored — only the non-secret prefix is shown."
        title="API tokens"
      />

      <section className="fade-up stagger-1 space-y-3">
        <SectionHeader
          actions={
            <Button
              disabled={pruneAudit.isPending}
              onClick={() => setPruneConfirmOpen(true)}
              size="sm"
              variant="secondary"
            >
              {pruneAudit.isPending ? 'Pruning…' : 'Prune shell audit (>90d)'}
            </Button>
          }
          hint={`${activeCount} active / ${rows.length} total · newest first`}
          number="01"
          title="All tokens"
        />

        {pruneError && <Alert>{pruneError}</Alert>}
        {pruneResult && !pruneError && (
          <Alert variant="success">Pruned {pruneResult.deleted} shell-audit rows.</Alert>
        )}
        {revokeToken.isError && (
          <Alert>Revoke failed: {errMsg(revokeToken.error, 'unknown error')}</Alert>
        )}

        <Card className="overflow-hidden p-0" variant="inset">
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
              {rows.map((t) => {
                const status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' = t.revokedAt
                  ? 'REVOKED'
                  : t.expiresAt && new Date(t.expiresAt).getTime() < now
                    ? 'EXPIRED'
                    : 'ACTIVE';
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
                  <EmptyState title="No tokens issued yet" />
                </TableStatusRow>
              )}
            </tbody>
          </Table>
        </Card>
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
      <ConfirmModal
        confirmLabel="Prune"
        dangerous
        message="Delete shell-audit rows older than 90 days? This cannot be undone."
        onClose={() => setPruneConfirmOpen(false)}
        onConfirm={handlePrune}
        open={pruneConfirmOpen}
        title="Prune shell audit"
      />
    </div>
  );
}
