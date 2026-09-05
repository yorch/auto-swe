'use client';

import { AuditLogTable } from '@/components/AuditLogTable';
import { useConfigAuditLog } from '@/hooks/useAdminConfig';

function ChangedFields({ json }: { json: unknown }) {
  if (!json || typeof json !== 'object') {
    return null;
  }
  const obj = json as Record<string, unknown>;
  const fields = obj.changedFields;
  if (!Array.isArray(fields) || fields.length === 0) {
    return null;
  }
  return <span className="text-paper-500">{(fields as string[]).join(', ')}</span>;
}

export function AuditLogTab() {
  const { data: entries, isLoading, isError, error } = useConfigAuditLog(200);

  return (
    <AuditLogTable
      caption={
        entries
          ? `Showing the last ${entries.length} config changes. Secret values are never recorded.`
          : undefined
      }
      emptyMessage="No config changes recorded yet. Changes to model config, credentials, and integration settings will appear here."
      entries={entries}
      error={error}
      isError={isError}
      isLoading={isLoading}
      summary={(entry) => <ChangedFields json={entry.afterJson} />}
      summaryHeader="Fields"
    />
  );
}
