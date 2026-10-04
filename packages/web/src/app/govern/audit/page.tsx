'use client';

import { useState } from 'react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  type AuditAction,
  type AuditLogFilters,
  type AuditLogRow,
  useAuditLog,
} from '@/hooks/useAdmin';
import { formatDate } from '@/lib/utils';

const LIMIT = 50;

const ACTION_OPTIONS = [
  { label: 'All actions', value: '' },
  { label: 'Create', value: 'CREATE' },
  { label: 'Update', value: 'UPDATE' },
  { label: 'Delete', value: 'DELETE' },
];

export default function GovernAuditPage() {
  const [filters, setFilters] = useState<AuditLogFilters>({});
  const [offset, setOffset] = useState(0);
  const { data, isLoading, isError, refetch, error } = useAuditLog({
    ...filters,
    limit: LIMIT,
    offset,
  });
  const rows = data?.data ?? [];
  const total = data?.meta.total ?? 0;
  // Keep the filter offering a type the current filter selected, even once the
  // log no longer holds it.
  const entityTypes = [
    ...new Set([
      ...(data?.meta.entityTypes ?? []),
      ...(filters.entityType ? [filters.entityType] : []),
    ]),
  ];

  /** Every filter change starts again from the first page. */
  function setFilter<K extends keyof AuditLogFilters>(key: K, value: AuditLogFilters[K]) {
    setFilters((f) => ({ ...f, [key]: value || undefined }));
    setOffset(0);
  }

  const hasFilters = Object.values(filters).some(Boolean);
  const filteredActor = filters.actorId
    ? (rows.find((r) => r.actorId === filters.actorId)?.actor?.email ?? filters.actorId)
    : null;

  return (
    <div className="space-y-8">
      <div className="fade-up">
        <PageHeader
          chapter="§ Govern"
          subtitle="Lifecycle changes to users, access tokens, sessions, and configuration, newest first. Secret values and credential hashes are never stored here."
          title="Audit log"
        />
      </div>

      <section className="fade-up stagger-1 space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Select
            aria-label="Filter by action"
            onChange={(v) => setFilter('action', v as AuditAction)}
            options={ACTION_OPTIONS}
            value={filters.action ?? ''}
          />
          <Select
            aria-label="Filter by entity type"
            onChange={(v) => setFilter('entityType', v)}
            options={[
              { label: 'All entity types', value: '' },
              ...entityTypes.map((t) => ({ label: t, value: t })),
            ]}
            value={filters.entityType ?? ''}
          />
          <Input
            aria-label="From date"
            max={filters.until}
            onChange={(e) => setFilter('since', e.target.value)}
            title="From (UTC, inclusive)"
            type="date"
            value={filters.since ?? ''}
          />
          <Input
            aria-label="To date"
            min={filters.since}
            onChange={(e) => setFilter('until', e.target.value)}
            title="To (UTC, inclusive)"
            type="date"
            value={filters.until ?? ''}
          />
        </div>
        {hasFilters && (
          <div className="flex flex-wrap items-center gap-2">
            {filteredActor && (
              <span className="font-mono text-[11px] text-paper-300" title={filters.actorId}>
                actor: {filteredActor}
              </span>
            )}
            <Button
              onClick={() => {
                setFilters({});
                setOffset(0);
              }}
              size="sm"
              variant="ghost"
            >
              Clear filters
            </Button>
          </div>
        )}
      </section>

      <section className="fade-up stagger-2 space-y-3">
        <Card className="overflow-hidden p-0" variant="inset">
          <QueryBoundary
            error={error}
            isError={isError}
            isLoading={isLoading}
            label="audit log"
            loadingMessage="loading audit log…"
            onRetry={() => void refetch()}
          >
            {rows.length === 0 && (
              <EmptyState
                title={
                  hasFilters ? 'No audit entries match these filters.' : 'No audit entries yet.'
                }
              />
            )}
            {rows.length > 0 && (
              <Table>
                <THead>
                  <Th>Time</Th>
                  <Th>Action</Th>
                  <Th>Actor</Th>
                  <Th>Entity</Th>
                  <Th>Safe detail</Th>
                </THead>
                <tbody>
                  {rows.map((row) => (
                    <TRow key={row.id}>
                      <Td className="px-4 py-3 font-mono text-[11px] text-paper-400">
                        {formatDate(row.createdAt, { showSeconds: true })}
                      </Td>
                      <Td className="px-4 py-3">
                        <AuditActionBadge action={row.action} />
                      </Td>
                      <Td className="px-4 py-3">
                        <AuditActor onFilter={(id) => setFilter('actorId', id)} row={row} />
                      </Td>
                      <Td className="px-4 py-3">
                        <span className="font-mono text-[11px] text-paper-200">
                          {row.entityType}
                        </span>
                        <span
                          className="block font-mono text-[10px] text-paper-500"
                          title={row.entityId}
                        >
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
        {total > 0 && (
          <Pagination
            hasNext={offset + rows.length < total}
            hasPrev={offset > 0}
            onNext={() => setOffset((o) => o + LIMIT)}
            onPrev={() => setOffset((o) => Math.max(0, o - LIMIT))}
            rangeEnd={Math.min(offset + LIMIT, total)}
            rangeStart={offset + 1}
            total={total}
          />
        )}
      </section>
    </div>
  );
}

/**
 * The actor by email, with the id on hover. Clicking it narrows the log to
 * that actor. A deleted user keeps their id; a system write has neither.
 */
function AuditActor({ row, onFilter }: { row: AuditLogRow; onFilter: (id: string) => void }) {
  if (!row.actorId) {
    return <span className="font-mono text-[11px] text-paper-500">system</span>;
  }
  const actorId = row.actorId;
  return (
    <button
      className="font-mono text-[11px] text-paper-300 hover:text-ember-400 hover:underline"
      onClick={() => onFilter(actorId)}
      title={`${actorId} — show only this actor`}
      type="button"
    >
      {row.actor?.email ?? `${actorId.slice(0, 8)}…`}
    </button>
  );
}

const AUDIT_ACTION_TONE: Record<AuditAction, BadgeTone> = {
  CREATE: 'moss',
  DELETE: 'brick',
  UPDATE: 'dust',
};

function AuditActionBadge({ action }: { action: AuditAction }) {
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
