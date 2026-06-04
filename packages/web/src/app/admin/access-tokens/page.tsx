'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { useAdminPruneShellAudit, useAdminRevokeToken, useAdminTokens } from '@/hooks/useWorkflows';
import { cn, formatDate, formatRelativeTime } from '@/lib/utils';

function StatusChip({ status }: { status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' }) {
  return (
    <span
      className={cn(
        'font-mono text-[10px] uppercase tracking-[0.14em]',
        status === 'ACTIVE' && 'text-emerald-400',
        status === 'EXPIRED' && 'text-amber-400',
        status === 'REVOKED' && 'text-paper-500 line-through'
      )}
    >
      {status}
    </span>
  );
}

function Th({
  children,
  align = 'left',
}: {
  children?: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      className={cn(
        'px-4 py-3 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-paper-500',
        align === 'right' ? 'text-right' : 'text-left'
      )}
    >
      {children}
    </th>
  );
}

export default function AdminAccessTokensPage() {
  const { data: tokens, isLoading } = useAdminTokens();
  const revokeToken = useAdminRevokeToken();
  const pruneAudit = useAdminPruneShellAudit(90);
  const [pruneResult, setPruneResult] = useState<{ deleted: number } | null>(null);
  const [pruneError, setPruneError] = useState<string | null>(null);

  const handleRevoke = (id: string, name: string) => {
    if (!window.confirm(`Revoke token "${name}"? This cannot be undone.`)) {
      return;
    }
    revokeToken.mutate(id);
  };

  const handlePrune = async () => {
    if (!window.confirm('Delete shell-audit rows older than 90 days? This cannot be undone.')) {
      return;
    }
    setPruneError(null);
    setPruneResult(null);
    try {
      const res = (await pruneAudit.mutateAsync()) as { data: { deleted: number } };
      setPruneResult(res.data);
    } catch (err) {
      setPruneError(err instanceof Error ? err.message : 'Prune failed');
    }
  };

  const now = Date.now();
  const rows = tokens ?? [];
  const activeCount = rows.filter(
    (t) => !t.revokedAt && !(t.expiresAt && new Date(t.expiresAt).getTime() < now)
  ).length;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20 font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500">
        <span className="pulse-dot mr-3 inline-block h-1.5 w-1.5 rounded-full bg-ember-400" />
        loading tokens…
      </div>
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
            {pruneError && <span className="font-mono text-[11px] text-red-400">{pruneError}</span>}
            {pruneResult && !pruneError && (
              <span className="font-mono text-[11px] text-paper-500">
                pruned {pruneResult.deleted} shell-audit rows
              </span>
            )}
            <Button
              disabled={pruneAudit.isPending}
              onClick={handlePrune}
              size="sm"
              variant="secondary"
            >
              {pruneAudit.isPending ? 'Pruning…' : 'Prune shell audit (>90d)'}
            </Button>
          </div>
        </div>

        {revokeToken.isError && (
          <p className="mb-3 font-mono text-[11px] text-red-400">
            Revoke failed:{' '}
            {revokeToken.error instanceof Error ? revokeToken.error.message : 'unknown error'}
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
                            onClick={() => handleRevoke(t.id, t.name)}
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
    </div>
  );
}
