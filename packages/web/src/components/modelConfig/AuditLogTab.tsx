'use client';

import { AuditLogTable } from '@/components/AuditLogTable';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useAdminConfigAuditLog } from '@/hooks/useModelConfig';

export function AuditLogTab() {
  const { data: rows, isLoading, isError, error } = useAdminConfigAuditLog({ limit: 100 });

  return (
    <Card>
      <CardHeader>
        <CardTitle eyebrow="Audit log">Recent config changes</CardTitle>
      </CardHeader>
      <AuditLogTable
        emptyMessage="No config changes recorded yet."
        entries={rows}
        error={error}
        isError={isError}
        isLoading={isLoading}
        showEntityId
        summary={(r) => summarize(r.beforeJson, r.afterJson)}
        summaryHeader="Summary"
      />
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
