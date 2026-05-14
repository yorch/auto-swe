'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAdminPruneShellAudit, useAdminRevokeToken, useAdminTokens } from '@/hooks/useWorkflows';
import { formatDate, formatRelativeTime } from '@/lib/utils';

export default function AdminAccessTokensPage() {
  const { data: tokens, isLoading } = useAdminTokens();
  const revokeToken = useAdminRevokeToken();
  const pruneAudit = useAdminPruneShellAudit(90);
  const [pruneResult, setPruneResult] = useState<{ deleted: number } | null>(null);

  const handleRevoke = (id: string, name: string) => {
    if (!window.confirm(`Revoke token "${name}"? This cannot be undone.`)) return;
    revokeToken.mutate(id);
  };

  const handlePrune = async () => {
    if (!window.confirm('Delete shell-audit rows older than 90 days? This cannot be undone.'))
      return;
    try {
      const res = (await pruneAudit.mutateAsync()) as { data: { deleted: number } };
      setPruneResult(res.data);
    } catch {
      // error surfaces in pruneAudit.error
    }
  };

  const now = new Date();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Admin — Access Tokens</h2>
        <div className="flex gap-3">
          {pruneResult && (
            <span className="text-sm text-[var(--muted-foreground)] self-center">
              Pruned {pruneResult.deleted} shell-audit rows
            </span>
          )}
          <button
            className="text-sm px-3 py-1.5 rounded border border-[var(--border)] hover:bg-[var(--muted)] disabled:opacity-50"
            disabled={pruneAudit.isPending}
            onClick={handlePrune}
            type="button"
          >
            {pruneAudit.isPending ? 'Pruning…' : 'Prune shell audit (>90d)'}
          </button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All personal access tokens</CardTitle>
        </CardHeader>
        <p className="text-xs text-[var(--muted-foreground)] px-4 pb-3">
          Platform admins can view and revoke any user's PAT. Token plaintexts are never stored —
          only the non-secret prefix and hash are shown.
        </p>

        {isLoading ? (
          <div className="text-center py-8 text-[var(--muted-foreground)]">Loading…</div>
        ) : !tokens || tokens.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-[var(--muted-foreground)]">No tokens issued yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted-foreground)]">
                  <th className="px-4 py-2 font-medium">User</th>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Prefix</th>
                  <th className="px-4 py-2 font-medium">Created</th>
                  <th className="px-4 py-2 font-medium">Last used</th>
                  <th className="px-4 py-2 font-medium">Expires</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => {
                  const status = t.revokedAt
                    ? 'REVOKED'
                    : t.expiresAt && new Date(t.expiresAt) < now
                      ? 'EXPIRED'
                      : 'ACTIVE';
                  return (
                    <tr
                      className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--muted)]"
                      key={t.id}
                    >
                      <td className="px-4 py-2 text-xs">{t.user.email}</td>
                      <td className="px-4 py-2">{t.name}</td>
                      <td className="px-4 py-2 font-mono text-xs">{t.prefix}</td>
                      <td className="px-4 py-2 text-xs text-[var(--muted-foreground)]">
                        {formatRelativeTime(t.createdAt)}
                      </td>
                      <td className="px-4 py-2 text-xs text-[var(--muted-foreground)]">
                        {t.lastUsedAt ? formatRelativeTime(t.lastUsedAt) : '—'}
                      </td>
                      <td className="px-4 py-2 text-xs text-[var(--muted-foreground)]">
                        {t.expiresAt ? formatDate(t.expiresAt) : 'never'}
                      </td>
                      <td className="px-4 py-2">
                        <StatusBadge status={status} />
                      </td>
                      <td className="px-4 py-2">
                        {!t.revokedAt && (
                          <button
                            className="text-xs text-red-600 hover:underline disabled:opacity-50"
                            disabled={revokeToken.isPending}
                            onClick={() => handleRevoke(t.id, t.name)}
                            type="button"
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
