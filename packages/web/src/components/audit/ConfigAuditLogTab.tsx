'use client';

import { useState } from 'react';
import { AuditLogTable } from '@/components/AuditLogTable';
import { Select } from '@/components/ui/Select';
import { useConfigAuditLog } from '@/hooks/useAdminConfig';
import {
  AUDIT_GROUP_OPTIONS,
  type AuditGroup,
  auditGroupOf,
  summarizeAuditChange,
} from '@/lib/configAudit';

/**
 * The one config audit log, used by the model and integration pages. `initialGroup` opens it on the
 * slice that page is about; the filter widens it to every change. Secret values are never recorded.
 */
export function ConfigAuditLogTab({ initialGroup }: { initialGroup: AuditGroup }) {
  const [group, setGroup] = useState<AuditGroup>(initialGroup);
  const { data, isLoading, isError, error } = useConfigAuditLog(200);
  const entries = data?.filter((e) => group === 'all' || auditGroupOf(e.entityType) === group);

  return (
    <div className="space-y-3">
      <Select
        aria-label="Filter changes"
        className="h-8 w-full text-[13px] sm:w-56"
        onChange={(v) => setGroup(v as AuditGroup)}
        options={AUDIT_GROUP_OPTIONS}
        value={group}
      />
      <AuditLogTable
        caption={
          entries
            ? `Showing ${entries.length} of the last ${data?.length ?? 0} changes. Secret values are never recorded.`
            : undefined
        }
        emptyMessage={
          group === 'all'
            ? 'No config changes recorded yet.'
            : 'No changes of this kind in the recent log. Choose All changes to see the rest.'
        }
        entries={entries}
        error={error}
        isError={isError}
        isLoading={isLoading}
        summary={(entry) => summarizeAuditChange(entry.beforeJson, entry.afterJson)}
        summaryHeader="What changed"
      />
    </div>
  );
}
