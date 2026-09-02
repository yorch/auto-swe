'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Th } from '@/components/ui/Th';
import { useAdminPruneShellAudit, useAdminRevokeToken, useAdminTokens } from '@/hooks/useAdmin';
import { errMsg } from '@/lib/errors';
import { cn, formatDate, formatRelativeTime } from '@/lib/utils';

function StatusChip({ status }: { status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' }) {
  return (
    <span
      className={cn(
        'font-mono text-[10px] uppercase tracking-[0.14em]',
        status === 'ACTIVE' && 'text-moss-400',
        status === 'EXPIRED' && 'text-amber-400',
        status === 'REVOKED' && 'text-paper-500 line-through'
      )}
    >
      {status}
    </span>
  );
}

export default function AdminAccessTokensPage() {
  const { data: tokens, isLoading, isError, error: loadError } = useAdminTokens();
  const revokeToken = useAdminRevokeToken();
  const pruneAudit = useAdminPruneShellAudit(90);
  const [pruneResult, setPruneResult] = useState<{ deleted: number } | null>(null);
  const [pruneError, setPruneError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);
  const [pruneConfirmOpen, setPruneConfirmOpen] = useState(false);

  const confirmRevoke = () => {
    if (revokeTarget) {
      revokeToken.mutate(revokeTarget.id);
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
        isLoading={isLoading}
        label="tokens"
        loadingMessage="loading tokens…"
      />
    );
  }

  return (
    <div className="space-y-10">
      <div className="fade-up">
        <PageHeader
          chapter={`§ Admin · Access Tokens · ${activeCount} active / ${rows.length} total`}
          subtitle="Platform admins can view and revoke any user's personal access token. Plaintexts are never stored — only the non-secret prefix is shown."
          title="Personal access tokens."
        />
      </div>

      <section className="fade-up stagger-1">
        <div className="mb-4 flex items-center justify-between">
          <SectionHeader hint="newest first" number="01" title="All tokens" />
          <div className="flex items-center gap-3">
            {pruneError && (
              <span className="font-mono text-[11px] text-brick-400">{pruneError}</span>
            )}
            {pruneResult && !pruneError && (
              <span className="font-mono text-[11px] text-paper-500">
                pruned {pruneResult.deleted} shell-audit rows
              </span>
            )}
            <Button
              disabled={pruneAudit.isPending}
              onClick={() => setPruneConfirmOpen(true)}
              size="sm"
              variant="secondary"
            >
              {pruneAudit.isPending ? 'Pruning…' : 'Prune shell audit (>90d)'}
            </Button>
          </div>
        </div>

        {revokeToken.isError && (
          <p className="mb-3 font-mono text-[11px] text-brick-400">
            Revoke failed: {errMsg(revokeToken.error, 'unknown error')}
          </p>
        )}

        <Card className="overflow-hidden p-0" variant="inset">
          {rows.length === 0 ? (
            <p className="px-4 py-8 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500">
              no tokens issued yet
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-600">
                  <Th>User</Th>
                  <Th>Name</Th>
                  <Th>Prefix</Th>
                  <Th>Created</Th>
                  <Th>Last used</Th>
                  <Th>Expires</Th>
                  <Th>Status</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' = t.revokedAt
                    ? 'REVOKED'
                    : t.expiresAt && new Date(t.expiresAt).getTime() < now
                      ? 'EXPIRED'
                      : 'ACTIVE';
                  return (
                    <tr className="border-b border-ink-600 last:border-b-0" key={t.id}>
                      <td className="px-4 py-3 text-sm text-paper-100">{t.user.email}</td>
                      <td className="px-4 py-3 text-sm text-paper-200">{t.name}</td>
                      <td className="px-4 py-3 font-mono text-[10px] text-paper-400">{t.prefix}</td>
                      <td className="px-4 py-3 font-mono text-[11px] text-paper-400">
                        {formatRelativeTime(t.createdAt)}
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-paper-400">
                        {t.lastUsedAt ? formatRelativeTime(t.lastUsedAt) : '—'}
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-paper-400">
                        {t.expiresAt ? formatDate(t.expiresAt) : 'never'}
                      </td>
                      <td className="px-4 py-3">
                        <StatusChip status={status} />
                      </td>
                      <td className="px-4 py-3 text-right">
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
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
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
