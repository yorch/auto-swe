'use client';

import { Suspense, use } from 'react';
import { BarList, DailyCountsChart } from '@/components/charts/AnalyticsCharts';
import { BackLink } from '@/components/ui/BackLink';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Stat } from '@/components/ui/Stat';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useAnalyticsUser } from '@/hooks/useAdmin';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { ApiError } from '@/lib/api';
import { platformRoleLabel, teamRoleLabel } from '@/lib/roleLabels';
import { validateRouteParam } from '@/lib/routeParams';
import {
  KIND_LABEL,
  KIND_TONE,
  methodLabel,
  parseDays,
  reasonLabel,
  WINDOW_DAYS,
} from '../../labels';
import { MaybeTime } from '../../MaybeTime';

const BACK = <BackLink href="/admin/user-analytics" label="User analytics" />;

function UserWorkspace({ id }: { id: string }) {
  const { params, update } = useUrlFilters();
  const days = parseDays(params.get('days'));
  const query = useAnalyticsUser(id, days);
  const d = query.data;
  const notFound = query.error instanceof ApiError && query.error.status === 404;
  const hint = `last ${days} days`;

  return (
    <div className="space-y-6">
      {BACK}
      <PageHeader
        actions={
          <SegmentedControl
            ariaLabel="Time window"
            onChange={(v) => update({ days: v === '14' ? null : v })}
            options={WINDOW_DAYS.map((n) => ({ label: `${n} days`, value: String(n) }))}
            value={String(days)}
          />
        }
        help={
          <p>
            Opening this page is itself recorded as a sensitive read. Addresses are truncated and
            the browser is a coarse family; no token or full user agent is kept.
          </p>
        }
        subtitle={d ? `${d.user.email} · ${platformRoleLabel(d.user.role)}` : undefined}
        title={d ? (d.user.name ?? d.user.email) : 'Person'}
      />
      {d && (
        <p className="-mt-6 text-sm text-paper-400">
          {d.user.teams.length === 0
            ? 'Not on any team.'
            : `Teams: ${d.user.teams.map((t) => `${t.slug} (${teamRoleLabel(t.role)})`).join(', ')}`}
          {' · Joined '}
          <RelativeTime value={d.user.createdAt} />
        </p>
      )}

      <QueryBoundary
        error={notFound ? null : query.error}
        isError={query.isError && !notFound}
        isFetching={query.isFetching}
        isLoading={query.isLoading}
        label="this person's analytics"
        onRetry={() => void query.refetch()}
      >
        {notFound || !d ? (
          <EmptyState title="Person not found" />
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Stat hint={hint} label="Sign-ins" value={d.summary.signIns} />
              <Stat
                hint={hint}
                label="Failed sign-ins"
                tone={d.summary.failedSignIns > 0 ? 'danger' : 'default'}
                value={d.summary.failedSignIns}
              />
              <Stat hint={hint} label="Actions" value={d.summary.actions} />
              <Stat hint={hint} label="Active days" value={d.summary.activeDays} />
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-paper-500">Last sign-in</dt>
                <dd className="text-paper-200">
                  <MaybeTime value={d.summary.lastSignInAt} />
                </dd>
              </div>
              <div>
                <dt className="text-paper-500">Last active</dt>
                <dd className="text-paper-200">
                  <MaybeTime value={d.summary.lastActiveAt} />
                </dd>
              </div>
              <div>
                <dt className="text-paper-500">First seen</dt>
                <dd className="text-paper-200">
                  <MaybeTime value={d.summary.firstSeenAt} />
                </dd>
              </div>
            </dl>

            <Card className="p-4 sm:p-6">
              <CardHeader>
                <CardTitle>Daily sign-ins and actions</CardTitle>
              </CardHeader>
              <DailyCountsChart
                data={d.daily}
                series={[
                  { key: 'signIns', label: 'Sign-ins' },
                  { key: 'actions', label: 'Actions' },
                  { key: 'failedSignIns', label: 'Failed sign-ins', tone: 'danger' },
                ]}
                title="Sign-ins and actions per day"
                yLabel="Count"
              />
            </Card>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card className="p-4 sm:p-6">
                <CardHeader>
                  <CardTitle>
                    Actions by type
                    <span className="ml-2 text-sm font-normal text-paper-400 tabular-nums">
                      · {d.actionsByAction.CREATE} created, {d.actionsByAction.UPDATE} updated,{' '}
                      {d.actionsByAction.DELETE} deleted
                    </span>
                  </CardTitle>
                </CardHeader>
                <BarList
                  empty="No actions in this window."
                  items={d.actionsByEntityType.map((e) => ({
                    count: e.count,
                    name: e.entityType,
                  }))}
                  label="Actions by entity type"
                />
              </Card>
              <Card className="p-4 sm:p-6">
                <CardHeader>
                  <CardTitle>Top pages</CardTitle>
                </CardHeader>
                {d.topPages.length === 0 ? (
                  <EmptyState
                    hint="Page views are opt-in. They are recorded only while the page-view setting is on."
                    title="No page views recorded"
                  />
                ) : (
                  <ul className="divide-y divide-ink-600">
                    {d.topPages.map((p) => (
                      <li className="flex items-center gap-3 py-2 text-sm" key={p.route}>
                        <code className="min-w-0 flex-1 break-all font-mono text-xs text-paper-300">
                          {p.route}
                        </code>
                        <span className="tabular-nums text-paper-100">{p.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            <Card className="p-4 sm:p-6">
              <CardHeader>
                <CardTitle>Sign-in history</CardTitle>
              </CardHeader>
              {d.signInHistory.length === 0 ? (
                <EmptyState title="No sign-ins recorded in this window" />
              ) : (
                <Table stacked>
                  <THead>
                    <tr>
                      <Th>Result</Th>
                      <Th>Method</Th>
                      <Th>Browser</Th>
                      <Th>OS</Th>
                      <Th>IP</Th>
                      <Th>When</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {d.signInHistory.map((h) => (
                      <TRow key={h.id}>
                        <Td primary>
                          <Badge tone={KIND_TONE[h.kind]} variant="outline">
                            {KIND_LABEL[h.kind]}
                          </Badge>
                          {h.kind === 'sign_in_failed' && h.reason && (
                            <span className="ml-2 text-xs text-paper-400">
                              {reasonLabel(h.reason)}
                            </span>
                          )}
                        </Td>
                        <Td label="Method">{methodLabel(h.method)}</Td>
                        <Td label="Browser">{h.browser ?? '—'}</Td>
                        <Td label="OS">{h.os ?? '—'}</Td>
                        <Td className="font-mono text-xs" label="IP">
                          {h.ip ?? '—'}
                        </Td>
                        <Td className="text-paper-400" label="When">
                          <RelativeTime value={h.createdAt} />
                        </Td>
                      </TRow>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>

            <Card className="p-4 sm:p-6">
              <CardHeader>
                <CardTitle>Recent actions</CardTitle>
              </CardHeader>
              {d.recentActions.length === 0 ? (
                <EmptyState title="No actions recorded" />
              ) : (
                <Table stacked>
                  <THead>
                    <tr>
                      <Th>What</Th>
                      <Th>Action</Th>
                      <Th>Via</Th>
                      <Th>When</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {d.recentActions.map((a) => (
                      <TRow key={a.id}>
                        <Td primary>
                          {a.entityType}
                          {a.entityId && (
                            <code className="ml-2 font-mono text-xs text-paper-500">
                              {a.entityId.slice(0, 8)}
                            </code>
                          )}
                        </Td>
                        <Td label="Action">{a.action}</Td>
                        <Td label="Via">{a.via ?? '—'}</Td>
                        <Td className="text-paper-400" label="When">
                          <RelativeTime value={a.createdAt} />
                        </Td>
                      </TRow>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>

            <Card className="p-4 sm:p-6">
              <CardHeader>
                <CardTitle>Active sessions</CardTitle>
              </CardHeader>
              {d.sessions.length === 0 ? (
                <EmptyState title="No active sessions" />
              ) : (
                <Table stacked>
                  <THead>
                    <tr>
                      <Th>Started</Th>
                      <Th>Expires</Th>
                      <Th>Browser</Th>
                      <Th>OS</Th>
                      <Th>IP</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {d.sessions.map((s) => (
                      <TRow key={s.id}>
                        <Td primary>
                          <RelativeTime value={s.createdAt} />
                        </Td>
                        <Td label="Expires">
                          <RelativeTime value={s.expiresAt} />
                        </Td>
                        <Td label="Browser">{s.browser ?? '—'}</Td>
                        <Td label="OS">{s.os ?? '—'}</Td>
                        <Td className="font-mono text-xs" label="IP">
                          {s.ipTruncated ?? '—'}
                        </Td>
                      </TRow>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}

export default function UserAnalyticsDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = use(params);
  const id = validateRouteParam(rawId);
  return (
    <Suspense fallback={null}>
      {id ? (
        <UserWorkspace id={id} />
      ) : (
        <div className="space-y-6">
          {BACK}
          <EmptyState title="Person not found" />
        </div>
      )}
    </Suspense>
  );
}
