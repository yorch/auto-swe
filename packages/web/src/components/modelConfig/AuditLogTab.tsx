'use client';

import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useAdminConfigAuditLog } from '@/hooks/useModelConfig';

export function AuditLogTab() {
  const { data: rows, isLoading } = useAdminConfigAuditLog({ limit: 100 });

  return (
    <Card>
      <CardHeader>
        <CardTitle eyebrow="Audit log">Recent config changes</CardTitle>
      </CardHeader>
      {isLoading && <p className="text-sm text-paper-400">Loading…</p>}
      {!isLoading && (rows ?? []).length === 0 && (
        <p className="text-sm text-paper-500">No config changes recorded yet.</p>
      )}
      <table className="w-full text-xs">
        <thead className="text-left uppercase tracking-wide text-paper-500">
          <tr>
            <th className="pb-2">When</th>
            <th className="pb-2">Action</th>
            <th className="pb-2">Entity</th>
            <th className="pb-2">Actor</th>
            <th className="pb-2">Summary</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((r) => (
            <tr className="border-t border-ink-700" key={r.id}>
              <td className="py-2 font-mono text-[11px] text-paper-400">
                {new Date(r.createdAt).toISOString().slice(0, 19).replace('T', ' ')}
              </td>
              <td className="py-2">
                <span
                  className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                    r.action === 'CREATE'
                      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                      : r.action === 'UPDATE'
                        ? 'bg-blue-500/15 text-blue-300 border-blue-500/30'
                        : 'bg-brick-500/15 text-brick-300 border-brick-500/30'
                  }`}
                >
                  {r.action}
                </span>
              </td>
              <td className="py-2 font-mono text-[11px]">
                {r.entityType}
                <span className="text-paper-500"> · {r.entityId.slice(0, 8)}…</span>
              </td>
              <td className="py-2 font-mono text-[11px] text-paper-400">
                {r.actorId ? r.actorId.slice(0, 8) + '…' : 'system'}
              </td>
              <td className="py-2 font-mono text-[10px] text-paper-400">
                {summarize(r.beforeJson, r.afterJson)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/// Best-effort one-line summary of a CRUD change. The audit log stores
/// pre/post snapshots; surface the most user-visible delta (modelSpec for
/// role configs, apiBase/lastFour for credentials).
function summarize(before: unknown, after: unknown): string {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const fields = ['modelSpec', 'apiBase', 'lastFour', 'credentialId'];
  const deltas = fields
    .filter((f) => f in a || f in b)
    .filter((f) => JSON.stringify(b[f] ?? null) !== JSON.stringify(a[f] ?? null))
    .map((f) => `${f}: ${JSON.stringify(b[f] ?? null)} → ${JSON.stringify(a[f] ?? null)}`);
  return deltas.length ? deltas.join('; ') : '—';
}
