'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { DateRangeControl } from '@/components/ui/DateRangeControl';
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
  exportAuditLog,
  useAdminPruneShellAudit,
  useAuditLog,
} from '@/hooks/useAdmin';
import { useUrlParams } from '@/hooks/useUrlParams';
import { entityHref, entityTypeLabel } from '@/lib/auditEntity';
import { type DateRange, dateRangePatch, parseDateRange, utcDay } from '@/lib/dateRange';
import { errMsg } from '@/lib/errors';
import { formatDate } from '@/lib/utils';

const LIMIT = 50;

const SHELL_AUDIT_KEEP_DAYS = 90;

const ACTION_OPTIONS = [
  { label: 'All actions', value: '' },
  { label: 'Created', value: 'CREATE' },
  { label: 'Changed', value: 'UPDATE' },
  { label: 'Deleted', value: 'DELETE' },
];

const ACTION_LABEL: Record<AuditAction, string> = {
  CREATE: 'Created',
  DELETE: 'Deleted',
  UPDATE: 'Changed',
};

/** The URL's range as the inclusive UTC days the gateway filters on; null is all time. */
function rangeDays(range: DateRange | null, now = new Date()): { since?: string; until?: string } {
  if (!range) {
    return {};
  }
  if (range.kind === 'custom') {
    return { since: range.from, until: range.to };
  }
  return { since: utcDay(new Date(now.getTime() - range.days * 86_400_000)), until: utcDay(now) };
}

function AuditWorkspace() {
  const { params, update } = useUrlParams();
  const range = params.get('range') ? parseDateRange(params) : null;
  const search = (params.get('search') ?? '').slice(0, 100);
  const [searchDraft, setSearchDraft] = useState(search);
  useEffect(() => setSearchDraft(search), [search]);
  const rawOffset = Number(params.get('offset') ?? 0);
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const rawAction = params.get('action');
  const filters: AuditLogFilters = {
    action: ACTION_OPTIONS.some((o) => o.value === rawAction)
      ? ((rawAction || undefined) as AuditAction | undefined)
      : undefined,
    actorId: params.get('actor') || undefined,
    entityType: params.get('entity') || undefined,
    search: search || undefined,
    ...rangeDays(range),
  };
  const pruneShellAudit = useAdminPruneShellAudit(SHELL_AUDIT_KEEP_DAYS);
  const [pruneOpen, setPruneOpen] = useState(false);
  const [pruned, setPruned] = useState<number | null>(null);
  const [pruneError, setPruneError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const { data, isLoading, isError, error } = useAuditLog({ ...filters, limit: LIMIT, offset });
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

  // Typing in the search box waits for a pause before it changes the URL (and the query).
  useEffect(() => {
    if (searchDraft === search) {
      return;
    }
    const timer = setTimeout(
      () => update({ offset: null, search: searchDraft.trim() || null }),
      300
    );
    return () => clearTimeout(timer);
  }, [searchDraft, search, update]);

  /** Every filter change starts again from the first page. */
  function setFilter(patch: Record<string, string | null>) {
    update({ ...patch, offset: null });
  }

  const hasFilters = Boolean(
    filters.action || filters.actorId || filters.entityType || filters.search || range
  );
  const filteredActor = filters.actorId
    ? (rows.find((r) => r.actorId === filters.actorId)?.actor?.email ?? 'one person')
    : null;

  async function handleExport() {
    setExporting(true);
    setExportError(null);
    setExportNotice(null);
    try {
      const { csv, truncated } = await exportAuditLog(filters);
      setExportNotice(
        truncated
          ? 'More entries matched than one export can hold, so the file has only the newest ones. Narrow the filters or the date range to export the rest.'
          : null
      );
      const href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.download = 'audit-log.csv';
      a.href = href;
      a.click();
      // Revoked later: some browsers start the download after click() returns.
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch (err) {
      setExportError(errMsg(err, 'Could not export the audit log'));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="fade-up">
        <PageHeader
          actions={
            <Button disabled={exporting || total === 0} onClick={handleExport} variant="secondary">
              {exporting ? 'Exporting…' : 'Export CSV'}
            </Button>
          }
          chapter="§ Govern"
          subtitle="Lifecycle changes to users, access tokens, sessions, and configuration, newest first. Secret values and credential hashes are never stored here."
          title="Audit log"
        />
      </div>

      <section className="fade-up stagger-1 space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Input
            aria-label="Search by person or entity"
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Search by person, entity type or id…"
            type="search"
            value={searchDraft}
          />
          <Select
            aria-label="Filter by action"
            onChange={(v) => setFilter({ action: v || null })}
            options={ACTION_OPTIONS}
            value={filters.action ?? ''}
          />
          <Select
            aria-label="Filter by entity type"
            onChange={(v) => setFilter({ entity: v || null })}
            options={[
              { label: 'All entity types', value: '' },
              ...entityTypes.map((t) => ({ label: entityTypeLabel(t), value: t })),
            ]}
            value={filters.entityType ?? ''}
          />
        </div>
        <DateRangeControl
          allowAll
          onChange={(r) =>
            // No range in the URL means all time, so a preset is always written out.
            setFilter(r ? dateRangePatch(r, -1) : { from: null, range: null, to: null })
          }
          value={range}
        />
        {hasFilters && (
          <div className="flex flex-wrap items-center gap-2">
            {filteredActor && (
              <span className="font-mono text-[11px] text-paper-300" title={filters.actorId}>
                actor: {filteredActor}
              </span>
            )}
            <Button
              onClick={() => {
                setSearchDraft('');
                update({
                  action: null,
                  actor: null,
                  entity: null,
                  from: null,
                  offset: null,
                  range: null,
                  search: null,
                  to: null,
                });
              }}
              size="sm"
              variant="ghost"
            >
              Clear filters
            </Button>
          </div>
        )}
        {exportError && <Alert variant="error">{exportError}</Alert>}
        {exportNotice && <Alert variant="warning">{exportNotice}</Alert>}
      </section>

      <section className="fade-up stagger-2 space-y-3">
        <Card className="overflow-hidden p-0" variant="inset">
          <QueryBoundary
            error={error}
            isError={isError}
            isLoading={isLoading}
            label="audit log"
            loadingMessage="loading audit log…"
          >
            {rows.length === 0 && (
              <EmptyState
                title={
                  hasFilters ? 'No audit entries match these filters.' : 'No audit entries yet.'
                }
              />
            )}
            {rows.length > 0 && (
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <Th>Time</Th>
                    <Th>Action</Th>
                    <Th>Actor</Th>
                    <Th>Entity</Th>
                    <Th>Change</Th>
                  </THead>
                  <tbody>
                    {rows.map((row) => (
                      <AuditRow
                        key={row.id}
                        onFilterActor={(id) => setFilter({ actor: id })}
                        row={row}
                      />
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
          </QueryBoundary>
        </Card>
        {total > 0 && (
          <Pagination
            hasNext={offset + rows.length < total}
            hasPrev={offset > 0}
            onNext={() => update({ offset: String(offset + LIMIT) })}
            onPrev={() => update({ offset: offset - LIMIT > 0 ? String(offset - LIMIT) : null })}
            rangeEnd={Math.min(offset + LIMIT, total)}
            rangeStart={offset + 1}
            total={total}
          />
        )}
      </section>

      <section className="fade-up stagger-3">
        <Card variant="inset">
          <CardHeader>
            <CardTitle eyebrow="Housekeeping">Shell command history</CardTitle>
          </CardHeader>
          <p className="mb-3 max-w-prose text-sm text-paper-400">
            Every command an agent runs in a workspace is recorded separately from this log. Delete
            entries older than {SHELL_AUDIT_KEEP_DAYS} days to keep that history small.
          </p>
          {pruneError && <Alert className="mb-3">{pruneError}</Alert>}
          {pruned !== null && !pruneError && (
            <Alert className="mb-3" variant="success">
              Deleted {pruned} shell command {pruned === 1 ? 'entry' : 'entries'}.
            </Alert>
          )}
          <Button
            disabled={pruneShellAudit.isPending}
            onClick={() => setPruneOpen(true)}
            size="sm"
            variant="secondary"
          >
            {pruneShellAudit.isPending
              ? 'Deleting…'
              : `Delete entries older than ${SHELL_AUDIT_KEEP_DAYS} days`}
          </Button>
        </Card>
      </section>

      <ConfirmModal
        confirmLabel="Delete entries"
        dangerous
        message={`Delete shell command history older than ${SHELL_AUDIT_KEEP_DAYS} days? This cannot be undone.`}
        onClose={() => setPruneOpen(false)}
        onConfirm={async () => {
          setPruneError(null);
          setPruned(null);
          try {
            const res = (await pruneShellAudit.mutateAsync()) as { data: { deleted: number } };
            setPruned(res.data.deleted);
          } catch (err) {
            setPruneError(errMsg(err, 'Could not delete the history'));
          }
        }}
        open={pruneOpen}
        title="Delete old shell command history"
      />
    </div>
  );
}

export default function GovernAuditPage() {
  return (
    <Suspense fallback={null}>
      <AuditWorkspace />
    </Suspense>
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
    <Badge tone={AUDIT_ACTION_TONE[action]} variant="outline">
      {ACTION_LABEL[action]}
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

/** The full values of one change: every key that differs, then the stored before and after. */
function AuditExpanded({ row }: { row: AuditLogRow }) {
  const b = (row.beforeJson ?? {}) as Record<string, unknown>;
  const a = (row.afterJson ?? {}) as Record<string, unknown>;
  const changes = diffKeys([...new Set([...Object.keys(b), ...Object.keys(a)])].sort(), b, a);
  return (
    <div className="space-y-3 px-4 py-3">
      {changes.length > 0 && (
        <ul className="space-y-1 font-mono text-[11px] text-paper-300">
          {changes.map((c) => (
            <li className="break-words" key={c}>
              {c}
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {(
          [
            ['Before', row.beforeJson],
            ['After', row.afterJson],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-paper-500">
              {label}
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[9px] border border-ink-400 bg-ink-900/60 p-2 font-mono text-[10px] text-paper-300">
              {value == null ? 'Nothing stored' : JSON.stringify(value, null, 2)}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

/** One log entry. Clicking the row opens its full before and after. */
function AuditRow({
  row,
  onFilterActor,
}: {
  row: AuditLogRow;
  onFilterActor: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const href = entityHref(row.entityType, row.entityId);
  return (
    <>
      <TRow>
        <Td className="px-4 py-3 font-mono text-[11px] text-paper-400">
          {formatDate(row.createdAt, { showSeconds: true })}
        </Td>
        <Td className="px-4 py-3">
          <AuditActionBadge action={row.action} />
        </Td>
        <Td className="px-4 py-3">
          <AuditActor onFilter={onFilterActor} row={row} />
        </Td>
        <Td className="px-4 py-3">
          <span className="text-xs text-paper-200">{entityTypeLabel(row.entityType)}</span>
          {href ? (
            <Link
              className="block font-mono text-[10px] text-ember-400 hover:underline"
              href={href}
              title={row.entityId}
            >
              {row.entityId.length > 12 ? `${row.entityId.slice(0, 8)}…` : row.entityId}
            </Link>
          ) : (
            <span className="block font-mono text-[10px] text-paper-500" title={row.entityId}>
              {row.entityId.length > 12 ? `${row.entityId.slice(0, 8)}…` : row.entityId}
            </span>
          )}
        </Td>
        <Td className="px-4 py-3 font-mono text-[10px] text-paper-400">
          <button
            aria-expanded={open}
            className="w-full text-left hover:text-paper-200"
            onClick={() => setOpen((v) => !v)}
            type="button"
          >
            <span className={open ? 'block break-words' : 'line-clamp-2 block'}>
              <AuditDetail after={row.afterJson} before={row.beforeJson} />
            </span>
            <span className="mt-1 block text-ember-400">
              {open ? 'Hide details' : 'Show details'}
            </span>
          </button>
        </Td>
      </TRow>
      {open && (
        <tr>
          <td className="border-t border-ink-500 bg-ink-900/40 p-0" colSpan={5}>
            <AuditExpanded row={row} />
          </td>
        </tr>
      )}
    </>
  );
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

  return <>{parts.length ? parts.join('; ') : '—'}</>;
}
