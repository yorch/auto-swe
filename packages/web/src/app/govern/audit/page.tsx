'use client';

import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useAuditLog } from '@/hooks/useAdmin';
import { formatDate } from '@/lib/utils';

export default function GovernAuditPage() {
  const { data: rows, isLoading, isError, error } = useAuditLog(200);

  return (
    <div className="space-y-8">
      <div className="fade-up">
        <PageHeader
          chapter="§ Govern"
          subtitle="The most recent lifecycle changes to users, access tokens, sessions, and configuration. Secret values and credential hashes are never stored here."
          title="Audit log"
        />
      </div>

      <section className="fade-up stagger-1">
        <Card className="overflow-hidden p-0" variant="inset">
          <QueryBoundary
            error={error}
            isError={isError}
            isLoading={isLoading}
            label="audit log"
            loadingMessage="loading audit log…"
          >
            {(rows ?? []).length === 0 && <EmptyState title="No audit entries yet." />}
            {(rows ?? []).length > 0 && (
              <Table>
                <THead>
                  <Th>Time</Th>
                  <Th>Action</Th>
                  <Th>Actor</Th>
                  <Th>Entity</Th>
                  <Th>Safe detail</Th>
                </THead>
                <tbody>
                  {(rows ?? []).map((row) => (
                    <TRow key={row.id}>
                      <Td className="px-4 py-3 font-mono text-[11px] text-paper-400">
                        {formatDate(row.createdAt, { showSeconds: true })}
                      </Td>
                      <Td className="px-4 py-3">
                        <AuditActionBadge action={row.action} />
                      </Td>
                      <Td className="px-4 py-3 font-mono text-[11px] text-paper-400">
                        {row.actorId ? `${row.actorId.slice(0, 8)}…` : 'system'}
                      </Td>
                      <Td className="px-4 py-3">
                        <span className="font-mono text-[11px] text-paper-200">
                          {row.entityType}
                        </span>
                        <span className="block font-mono text-[10px] text-paper-500">
                          {row.entityId.slice(0, 8)}…
                        </span>
                      </Td>
                      <Td className="px-4 py-3 font-mono text-[10px] text-paper-400">
                        <AuditDetail after={row.afterJson} before={row.beforeJson} />
                      </Td>
                    </TRow>
                  ))}
                </tbody>
              </Table>
            )}
          </QueryBoundary>
        </Card>
      </section>
    </div>
  );
}

const AUDIT_ACTION_TONE: Record<'CREATE' | 'DELETE' | 'UPDATE', BadgeTone> = {
  CREATE: 'moss',
  DELETE: 'brick',
  UPDATE: 'dust',
};

function AuditActionBadge({ action }: { action: 'CREATE' | 'DELETE' | 'UPDATE' }) {
  return (
    <Badge tone={AUDIT_ACTION_TONE[action]} uppercase variant="outline">
      {action}
    </Badge>
  );
}

/** The keys worth leading with, in this order, when a row has them. */
const AUDIT_SUMMARY_KEYS = [
  'reason',
  'changedFields',
  'revoked',
  'id',
  'email',
  'role',
  'name',
  'prefix',
  'key',
];

/** `key: before → after` for every key whose value actually changed. */
function diffKeys(
  keys: string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>
): string[] {
  const parts: string[] = [];
  for (const key of keys) {
    if (!(key in after || key in before)) {
      continue;
    }
    const beforeVal = JSON.stringify(before[key] ?? null);
    const afterVal = JSON.stringify(after[key] ?? null);
    if (beforeVal !== afterVal) {
      parts.push(`${key}: ${beforeVal} → ${afterVal}`);
    }
  }
  return parts;
}

function AuditDetail({ before, after }: { before: unknown; after: unknown }) {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;

  // Known keys first, then everything else. Without the fallback a row whose
  // keys nobody thought to list here renders as a bare dash — which is what a
  // detected GitHub-login takeover did, showing as an ordinary user update with
  // no detail at all, in the surface added specifically so it could be found.
  // Any future writer gets legible output without editing this list.
  const known = diffKeys(AUDIT_SUMMARY_KEYS, b, a);
  const parts = known.length
    ? known
    : diffKeys([...new Set([...Object.keys(b), ...Object.keys(a)])].sort(), b, a);

  return <span className="line-clamp-2">{parts.length ? parts.join('; ') : '—'}</span>;
}
