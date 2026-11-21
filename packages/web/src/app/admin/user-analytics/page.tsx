'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { BarList, DailyCountsChart, PeakHoursChart } from '@/components/charts/AnalyticsCharts';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Stat } from '@/components/ui/Stat';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { type AnalyticsUserSort, useAnalyticsOverview, useAnalyticsUsers } from '@/hooks/useAdmin';
import { parseOffset, useUrlFilters } from '@/hooks/useUrlFilters';
import { downloadCsv, exportErrorMessage } from './exportCsv';
import { methodLabel, parseDays, personLabel, reasonLabel, WINDOW_DAYS } from './labels';
import { MaybeTime } from './MaybeTime';
import { SignInAlertsCard } from './SignInAlertsCard';

const LIMIT = 25;
const SORTS: AnalyticsUserSort[] = ['lastActive', 'actions', 'signIns', 'failed', 'email'];

function Loading() {
  return (
    <p className="py-6 text-center text-sm text-paper-500" role="status">
      Loading…
    </p>
  );
}

function AnalyticsWorkspace() {
  const { params, update } = useUrlFilters();
  const days = parseDays(params.get('days'));
  const q = params.get('q') ?? '';
  const rawSort = params.get('sort');
  const sort = (SORTS as string[]).includes(rawSort ?? '')
    ? (rawSort as AnalyticsUserSort)
    : 'lastActive';
  const order = params.get('order') === 'asc' ? 'asc' : 'desc';
  const offset = parseOffset(params.get('offset'));

  const overview = useAnalyticsOverview(days);
  const users = useAnalyticsUsers({ days, limit: LIMIT, offset, order, q: q || undefined, sort });
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState<string | null>(null);
  const exportPeople = () => {
    setExporting(true);
    setExportFailed(null);
    downloadCsv({ days, order, q: q || undefined, sort })
      .catch((err: unknown) => setExportFailed(exportErrorMessage(err)))
      .finally(() => setExporting(false));
  };
  const o = overview.data;
  const rows = users.data?.data ?? [];
  const total = users.data?.meta.total ?? 0;

  // The search box keeps its own text so typing is not interrupted by the URL round trip.
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);
  useEffect(() => {
    if (search === q) {
      return;
    }
    const t = setTimeout(() => update({ offset: null, q: search || null }), 300);
    return () => clearTimeout(t);
  }, [search, q, update]);

  const sortProps = (key: AnalyticsUserSort) => ({
    onSort: () =>
      update({
        offset: null,
        order: sort === key && order === 'desc' ? 'asc' : 'desc',
        sort: key,
      }),
    sort:
      sort === key
        ? order === 'asc'
          ? ('ascending' as const)
          : ('descending' as const)
        : ('none' as const),
  });

  const failed = o?.signIns.failed ?? 0;
  const hint = overview.isLoading ? 'Loading…' : `last ${days} days`;

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <SegmentedControl
            ariaLabel="Time window"
            onChange={(v) => update({ days: v === '14' ? null : v, offset: null })}
            options={WINDOW_DAYS.map((d) => ({ label: `${d} days`, value: String(d) }))}
            value={String(days)}
          />
        }
        help={
          <p>
            Counts refresh every minute. A person is active on a day when they signed in, changed
            something, opened a page or read or exported something sensitive. Days are UTC.
          </p>
        }
        subtitle="Who signs in, how often, and what they do."
        title="User analytics"
      />

      <SignInAlertsCard />

      {overview.isError && (
        <Alert
          action={
            <Button onClick={() => void overview.refetch()} size="sm">
              Retry
            </Button>
          }
          variant="error"
        >
          The analytics overview could not be loaded, so the figures below are unknown — not zero.
          {overview.error instanceof Error && overview.error.message
            ? ` ${overview.error.message}`
            : ''}
        </Alert>
      )}
      {o?.truncated && (
        <Alert title="Counts are partial" variant="warning">
          This window holds more rows than one request reads, so some figures are lower than what
          happened. Choose a shorter window for exact numbers.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat hint="today" label="Daily active" value={o ? o.users.dau : '—'} />
        <Stat hint="last 7 days" label="Weekly active" value={o ? o.users.wau : '—'} />
        <Stat hint="last 30 days" label="Monthly active" value={o ? o.users.mau : '—'} />
        <Stat
          hint="daily ÷ monthly active"
          label="Stickiness"
          value={o ? `${o.users.stickinessPct}%` : '—'}
        />
        <Stat hint={hint} label="Sign-ins" value={o ? o.signIns.total : '—'} />
        <Stat
          hint={hint}
          label="Failed sign-ins"
          tone={failed > 0 ? 'danger' : 'default'}
          value={o ? failed : '—'}
        />
        <Stat hint="not yet expired" label="Active sessions" value={o ? o.activeSessions : '—'} />
        <Stat
          hint={o ? `${o.users.neverSignedIn} never signed in` : hint}
          label="New users"
          value={o ? o.users.newInWindow : '—'}
        />
      </div>

      <Card className="p-4 sm:p-6">
        <CardHeader>
          <CardTitle>Active users &amp; sign-ins by day</CardTitle>
        </CardHeader>
        {o ? (
          <DailyCountsChart
            data={o.activeByDay}
            series={[
              { key: 'activeUsers', label: 'Active users' },
              { key: 'signIns', label: 'Sign-ins' },
              { key: 'actions', label: 'Actions' },
              { key: 'failedSignIns', label: 'Failed sign-ins', tone: 'danger' },
            ]}
            title="Active users and sign-ins per day"
            yLabel="Count"
          />
        ) : overview.isError ? (
          <EmptyState icon="error" title="Could not load the daily counts" />
        ) : (
          <Loading />
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="p-4 sm:p-6">
          <CardHeader>
            <CardTitle>Sign-ins by method</CardTitle>
          </CardHeader>
          {o ? (
            <BarList
              items={o.signIns.byMethod.map((m) => ({
                count: m.count,
                name: methodLabel(m.method),
              }))}
              label="Sign-ins by method"
            />
          ) : (
            <Loading />
          )}
        </Card>
        <Card className="p-4 sm:p-6">
          <CardHeader>
            <CardTitle>Sign-ins by browser</CardTitle>
          </CardHeader>
          {o ? <BarList items={o.signIns.byBrowser} label="Sign-ins by browser" /> : <Loading />}
        </Card>
        <Card className="p-4 sm:p-6">
          <CardHeader>
            <CardTitle>Sign-ins by operating system</CardTitle>
          </CardHeader>
          {o ? (
            <BarList items={o.signIns.byOs} label="Sign-ins by operating system" />
          ) : (
            <Loading />
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4 sm:p-6">
          <CardHeader>
            <CardTitle>
              Actions by type
              {o && (
                <span className="ml-2 text-sm font-normal text-paper-400 tabular-nums">
                  · {o.actions.total} ({o.actions.byAction.CREATE} created,{' '}
                  {o.actions.byAction.UPDATE} updated, {o.actions.byAction.DELETE} deleted)
                </span>
              )}
            </CardTitle>
          </CardHeader>
          {o ? (
            <BarList
              empty="No actions in this window."
              items={o.actions.byEntityType.map((e) => ({ count: e.count, name: e.entityType }))}
              label="Actions by entity type"
            />
          ) : (
            <Loading />
          )}
        </Card>
        <Card className="p-4 sm:p-6">
          <CardHeader>
            <CardTitle>Peak hours (UTC)</CardTitle>
          </CardHeader>
          {o ? (
            <PeakHoursChart hours={o.peakHours} title="Sign-ins and actions by hour" />
          ) : (
            <Loading />
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4 sm:p-6">
          <CardHeader>
            <CardTitle>Most active users</CardTitle>
          </CardHeader>
          {o && o.topUsers.length === 0 ? (
            <EmptyState title="No actions in this window" />
          ) : o ? (
            <Table>
              <THead>
                <tr>
                  <Th>Person</Th>
                  <Th align="right">Actions</Th>
                  <Th align="right">Sign-ins</Th>
                  <Th>Last active</Th>
                </tr>
              </THead>
              <tbody>
                {o.topUsers.map((u) => (
                  <TRow key={u.userId}>
                    <Td>
                      <Link
                        className="text-accent-400 hover:underline"
                        href={`/admin/user-analytics/users/${u.userId}`}
                      >
                        {u.name ?? u.email}
                      </Link>
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {u.actions}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {u.signIns}
                    </Td>
                    <Td className="text-paper-400">
                      <MaybeTime value={u.lastActiveAt} />
                    </Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          ) : (
            <Loading />
          )}
        </Card>

        <Card className={`p-4 sm:p-6 ${failed > 0 ? 'border-danger-400/40' : ''}`}>
          <CardHeader>
            <CardTitle>Recent failed sign-ins</CardTitle>
          </CardHeader>
          {o && o.recentFailures.length === 0 ? (
            <EmptyState title="No failed sign-ins recorded" />
          ) : o ? (
            <Table>
              <THead>
                <tr>
                  <Th>Person</Th>
                  <Th>Method</Th>
                  <Th>Reason</Th>
                  <Th>IP</Th>
                  <Th>When</Th>
                </tr>
              </THead>
              <tbody>
                {o.recentFailures.map((f) => (
                  <TRow key={f.id}>
                    <Td>
                      {f.userId ? (
                        <Link
                          className="text-accent-400 hover:underline"
                          href={`/admin/user-analytics/users/${f.userId}`}
                        >
                          {f.email ?? f.userId.slice(0, 8)}
                        </Link>
                      ) : (
                        (f.email ?? 'Unknown')
                      )}
                    </Td>
                    <Td>{methodLabel(f.method)}</Td>
                    <Td>
                      <Badge tone="danger" variant="outline">
                        {reasonLabel(f.reason)}
                      </Badge>
                    </Td>
                    <Td className="font-mono text-xs">{f.ip ?? '—'}</Td>
                    <Td className="text-paper-400">
                      <RelativeTime value={f.createdAt} />
                    </Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          ) : (
            <Loading />
          )}
        </Card>
      </div>

      <Card className="p-4 sm:p-6">
        <CardHeader>
          <CardTitle>
            People
            {total > 0 && (
              <span className="ml-2 text-sm font-normal text-paper-400 tabular-nums">
                · {total}
              </span>
            )}
          </CardTitle>
          {/* Outside the boundary: typing refetches, and the field must keep focus. */}
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <Button disabled={exporting} onClick={exportPeople} size="sm" variant="secondary">
              {exporting ? 'Exporting…' : 'Export CSV'}
            </Button>
            {exportFailed && (
              <span className="text-xs text-danger-400" role="alert">
                {exportFailed}
              </span>
            )}
          </div>
          <div className="w-full sm:w-64">
            <Input
              aria-label="Search people"
              compact
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or email"
              type="search"
              value={search}
            />
          </div>
        </CardHeader>
        <QueryBoundary
          error={users.error}
          isError={users.isError}
          isFetching={users.isFetching}
          isLoading={users.isLoading}
          label="people"
          onRetry={() => void users.refetch()}
        >
          {users.data?.meta.truncated && (
            <p className="mb-3 text-sm text-warning-400">
              Counts for this window are partial; choose a shorter window for exact numbers.
            </p>
          )}
          {rows.length === 0 ? (
            <EmptyState title={q ? 'No one matches that search' : 'No people found'} />
          ) : (
            <Table stacked>
              <THead>
                <tr>
                  <Th {...sortProps('email')}>Person</Th>
                  <Th>Role</Th>
                  <Th {...sortProps('lastActive')}>Last active</Th>
                  <Th align="right" {...sortProps('signIns')}>
                    Sign-ins
                  </Th>
                  <Th align="right" {...sortProps('failed')}>
                    Failed
                  </Th>
                  <Th align="right" {...sortProps('actions')}>
                    Actions
                  </Th>
                  <Th align="right">Active days</Th>
                  <Th align="right">Sessions</Th>
                </tr>
              </THead>
              <tbody>
                {rows.map((u) => (
                  <TRow key={u.userId}>
                    <Td primary>
                      <Link
                        className="text-accent-400 hover:underline"
                        href={`/admin/user-analytics/users/${u.userId}`}
                      >
                        {personLabel(u)}
                      </Link>
                    </Td>
                    <Td label="Role">{u.role}</Td>
                    <Td className="text-paper-400" label="Last active">
                      <MaybeTime value={u.lastActiveAt} />
                    </Td>
                    <Td align="right" className="tabular-nums" label="Sign-ins">
                      {u.signIns}
                    </Td>
                    <Td
                      align="right"
                      className={`tabular-nums ${u.failedSignIns > 0 ? 'text-danger-400' : ''}`}
                      label="Failed"
                    >
                      {u.failedSignIns}
                    </Td>
                    <Td align="right" className="tabular-nums" label="Actions">
                      {u.actions}
                    </Td>
                    <Td align="right" className="tabular-nums" label="Active days">
                      {u.activeDays}
                    </Td>
                    <Td align="right" className="tabular-nums" label="Sessions">
                      {u.activeSessions}
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

export default function UserAnalyticsPage() {
  return (
    <Suspense fallback={null}>
      <AnalyticsWorkspace />
    </Suspense>
  );
}
