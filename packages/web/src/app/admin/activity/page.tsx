'use client';

import { Suspense } from 'react';
import { ActivityByDayChart } from '@/components/charts/ActivityByDayChart';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Select } from '@/components/ui/Select';
import { Stat } from '@/components/ui/Stat';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  type ActivityEventRow,
  type ActivityKind,
  useActivityEvents,
  useActivitySummary,
} from '@/hooks/useAdmin';
import { parseOffset, useUrlFilters } from '@/hooks/useUrlFilters';

const LIMIT = 50;
const SUMMARY_DAYS = 14;

const KINDS: ActivityKind[] = ['denied', 'read', 'export', 'ui'];
const KIND_LABEL: Record<ActivityKind, string> = {
  denied: 'Denied',
  export: 'Export',
  read: 'Sensitive read',
  ui: 'Page view',
};
const KIND_TONE: Record<ActivityKind, BadgeTone> = {
  denied: 'danger',
  export: 'warning',
  read: 'neutral',
  ui: 'muted',
};
const KIND_OPTIONS = [
  { label: 'All kinds', value: '' },
  ...KINDS.map((k) => ({ label: KIND_LABEL[k], value: k })),
];

function actorLabel(row: ActivityEventRow): string {
  if (row.actor) {
    return row.actor.email;
  }
  return row.actorId ? `${row.actorId.slice(0, 8)}…` : 'Unknown';
}

function ActivityWorkspace() {
  const { params, update } = useUrlFilters();
  const rawKind = params.get('kind');
  const kind = (KINDS as string[]).includes(rawKind ?? '') ? (rawKind as ActivityKind) : undefined;
  const offset = parseOffset(params.get('offset'));
  const summary = useActivitySummary(SUMMARY_DAYS);
  const events = useActivityEvents({ kind, limit: LIMIT, offset });
  const rows = events.data?.data ?? [];
  const total = events.data?.meta.total ?? 0;
  const s = summary.data;

  return (
    <div className="space-y-6">
      <PageHeader
        help={
          <p>
            Events refresh every 30 seconds. Routes are templates, never URLs: no ids, query strings
            or request bodies are recorded.
          </p>
        }
        subtitle="Who was refused, and who looked at something sensitive. Page views appear only while they are switched on."
        title="User activity"
      />

      {summary.isError && (
        <Alert
          action={
            <Button onClick={() => void summary.refetch()} size="sm">
              Retry
            </Button>
          }
          variant="error"
        >
          The activity summary could not be loaded, so the counts below are unknown — not zero.
          {summary.error instanceof Error && summary.error.message
            ? ` ${summary.error.message}`
            : ''}
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {KINDS.map((k) => (
          <Stat
            hint={summary.isLoading ? 'Loading…' : `last ${SUMMARY_DAYS} days`}
            key={k}
            label={KIND_LABEL[k]}
            tone={k === 'denied' && (s?.totals.denied ?? 0) > 0 ? 'danger' : 'default'}
            value={s ? s.totals[k] : '—'}
          />
        ))}
      </div>

      {s && (
        <p className="text-sm text-paper-400">
          Kept for {s.retentionDays} days. Page views are {s.uiEventsEnabled ? 'on' : 'off'}.
        </p>
      )}
      {s && s.dropped > 0 && (
        <Alert title="Some events were not recorded" variant="warning">
          This gateway process dropped {s.dropped} events since it started (queue full, rate-limited
          or a failed write), so the counts above can be lower than what happened.
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4 sm:p-6">
          <CardHeader>
            <CardTitle>By day</CardTitle>
          </CardHeader>
          {s && s.daily.length > 0 ? (
            <ActivityByDayChart data={s.daily} title="Activity events per day" />
          ) : summary.isError ? (
            <EmptyState icon="error" title="Could not load the daily counts" />
          ) : s ? (
            <EmptyState title="No events in this window" />
          ) : (
            <p className="py-6 text-center text-sm text-paper-500" role="status">
              Loading…
            </p>
          )}
        </Card>

        <Card className="p-4 sm:p-6">
          <CardHeader>
            <CardTitle>Top denied routes</CardTitle>
          </CardHeader>
          {s && s.topDenied.length > 0 ? (
            <ul className="divide-y divide-ink-600">
              {s.topDenied.map((r) => (
                <li className="flex items-center gap-3 py-2 text-sm" key={r.route}>
                  <code className="min-w-0 flex-1 break-all font-mono text-xs text-paper-300">
                    {r.route}
                  </code>
                  <span className="tabular-nums text-paper-100">{r.count}</span>
                </li>
              ))}
            </ul>
          ) : summary.isError ? (
            <EmptyState icon="error" title="Could not load denied routes" />
          ) : s ? (
            <EmptyState title="No denied requests in this window" />
          ) : (
            <p className="py-6 text-center text-sm text-paper-500" role="status">
              Loading…
            </p>
          )}
        </Card>
      </div>

      <Card className="p-4 sm:p-6">
        <CardHeader>
          <CardTitle>
            Recent events
            {total > 0 && (
              <span className="ml-2 text-sm font-normal text-paper-400 tabular-nums">
                · {total}
              </span>
            )}
          </CardTitle>
          {/* Outside the boundary: a filter change refetches, and the control must keep focus. */}
          <div className="w-full sm:w-52">
            <Select
              aria-label="Filter by kind"
              className="h-8 text-sm"
              onChange={(v) => update({ kind: v || null, offset: null })}
              options={KIND_OPTIONS}
              value={kind ?? ''}
            />
          </div>
        </CardHeader>
        <QueryBoundary
          error={events.error}
          isError={events.isError}
          isFetching={events.isFetching}
          isLoading={events.isLoading}
          label="activity events"
          onRetry={() => void events.refetch()}
        >
          {rows.length === 0 ? (
            <EmptyState title="No events recorded" />
          ) : (
            <Table stacked>
              <THead>
                <tr>
                  <Th>Route</Th>
                  <Th>Kind</Th>
                  <Th>Who</Th>
                  <Th>Status</Th>
                  <Th>When</Th>
                </tr>
              </THead>
              <tbody>
                {rows.map((row) => (
                  <TRow key={row.id}>
                    <Td primary>
                      <code className="break-all font-mono text-xs text-paper-200">
                        {row.method} {row.route}
                      </code>
                    </Td>
                    <Td label="Kind">
                      <Badge tone={KIND_TONE[row.kind]} variant="outline">
                        {KIND_LABEL[row.kind]}
                      </Badge>
                    </Td>
                    <Td label="Who">{actorLabel(row)}</Td>
                    <Td className="tabular-nums" label="Status">
                      {row.status ?? '—'}
                    </Td>
                    <Td className="text-paper-400" label="When">
                      <RelativeTime value={row.createdAt} />
                    </Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          )}
          {total > 0 && (
            <div className="mt-4 border-t border-ink-600 pt-4">
              <Pagination
                hasNext={offset + rows.length < total}
                hasPrev={offset > 0}
                onNext={() => update({ offset: String(offset + LIMIT) })}
                onPrev={() =>
                  update({ offset: offset - LIMIT > 0 ? String(offset - LIMIT) : null })
                }
                rangeEnd={Math.min(offset + LIMIT, total)}
                rangeStart={offset + 1}
                total={total}
              />
            </div>
          )}
        </QueryBoundary>
      </Card>
    </div>
  );
}

export default function UserActivityPage() {
  return (
    <Suspense fallback={null}>
      <ActivityWorkspace />
    </Suspense>
  );
}
