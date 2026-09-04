'use client';

import { Card } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Th } from '@/components/ui/Th';
import { useAuditLog } from '@/hooks/useAdmin';
import { formatDate } from '@/lib/utils';

export default function GovernAuditPage() {
  const { data: rows, isLoading } = useAuditLog(200);

  return (
    <div className="space-y-10">
      <div className="fade-up">
        <PageHeader
          chapter={`§ Admin · Audit log · ${(rows ?? []).length} most recent`}
          subtitle="Lifecycle changes to users, access tokens, sessions, and configuration. Secret values and credential hashes are never stored here."
          title="Audit log."
        />
      </div>

      <section className="fade-up stagger-1">
        <Card className="overflow-hidden p-0" variant="inset">
          {isLoading && <LoadingState message="loading audit log…" />}
          {!isLoading && (rows ?? []).length === 0 && (
            <p className="px-4 py-8 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500">
              no audit entries yet
            </p>
          )}
          {!isLoading && (rows ?? []).length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-600">
                  <Th>Time</Th>
                  <Th>Action</Th>
                  <Th>Actor</Th>
                  <Th>Entity</Th>
                  <Th>Safe detail</Th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((row) => (
                  <tr className="border-b border-ink-600 last:border-b-0" key={row.id}>
                    <td className="px-4 py-3 font-mono text-[11px] text-paper-400">
                      {formatDate(row.createdAt, { showSeconds: true })}
                    </td>
                    <td className="px-4 py-3">
                      <AuditActionBadge action={row.action} />
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-paper-400">
                      {row.actorId ? `${row.actorId.slice(0, 8)}…` : 'system'}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-[11px] text-paper-200">{row.entityType}</span>
                      <span className="block font-mono text-[10px] text-paper-500">
                        {row.entityId.slice(0, 8)}…
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-[10px] text-paper-400">
                      <AuditDetail after={row.afterJson} before={row.beforeJson} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>
    </div>
  );
}

function AuditActionBadge({ action }: { action: 'CREATE' | 'DELETE' | 'UPDATE' }) {
  const colors = {
    CREATE: 'bg-moss-400/15 text-moss-400 border-moss-400/30',
    DELETE: 'bg-brick-500/15 text-brick-300 border-brick-500/30',
    UPDATE: 'bg-dust-400/15 text-dust-400 border-dust-400/30',
  };
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${colors[action]}`}
    >
      {action}
    </span>
  );
}

function AuditDetail({ before, after }: { before: unknown; after: unknown }) {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const summaryKeys = ['changedFields', 'revoked', 'id', 'email', 'role', 'name', 'prefix', 'key'];
  const parts: string[] = [];
  for (const key of summaryKeys) {
    if (key in a || key in b) {
      const beforeVal = JSON.stringify(b[key] ?? null);
      const afterVal = JSON.stringify(a[key] ?? null);
      if (beforeVal !== afterVal) {
        parts.push(`${key}: ${beforeVal} → ${afterVal}`);
      }
    }
  }
  return <span className="line-clamp-2">{parts.length ? parts.join('; ') : '—'}</span>;
}
