'use client';

import { Suspense, useMemo, useState } from 'react';
import { DailyCostChart } from '@/components/charts/DailyCostChart';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { DateRangeControl } from '@/components/ui/DateRangeControl';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select, type SelectOption } from '@/components/ui/Select';
import { Stat } from '@/components/ui/Stat';
import { StatusBadge } from '@/components/ui/StatusBadge';
import {
  type PlatformUsage,
  type UsageBucket,
  type UsageScope,
  usePlatformUsage,
  useUsageScopes,
} from '@/hooks/useAdmin';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import {
  customRangeIgnored,
  dateRangePatch,
  parseDateRange,
  rangeDays,
  rangePhrase,
} from '@/lib/dateRange';
import { formatDelta } from '@/lib/delta';
import { runHref } from '@/lib/entityLinks';
import { humanizeKey } from '@/lib/govLabels';
import {
  cn,
  formatCount,
  formatDuration,
  formatPercent,
  formatTokens,
  formatTotalCost,
} from '@/lib/utils';

/** `''` is platform-wide; `team:<id>` and `org:<id>` name a tenant. */
function scopeOf(value: string): UsageScope {
  const [kind, id] = value.split(':');
  return kind === 'team' ? { teamId: id } : kind === 'org' ? { orgId: id } : {};
}

/**
 * The scopes the caller may read, as the gateway reports them. `null` until
 * they are known.
 */
function useScopeOptions(): SelectOption[] | null {
  const scopes = useUsageScopes();
  return useMemo(() => {
    if (!scopes.data) {
      return null;
    }
    return [
      ...(scopes.data.platform ? [{ label: 'Whole platform', value: '' }] : []),
      ...scopes.data.teams.map((t) => ({ label: `Team: ${t.name}`, value: `team:${t.id}` })),
      ...scopes.data.orgs.map((o) => ({ label: `Organization: ${o.name}`, value: `org:${o.id}` })),
    ];
  }, [scopes.data]);
}

function errorRate(b: UsageBucket): number | null {
  return b.calls > 0 ? b.errors / b.calls : null;
}

type Dimension = 'team' | 'org' | 'model' | 'agent' | 'activity';
type SortKey = 'label' | 'calls' | 'tokens' | 'latency' | 'errorRate' | 'cost';

const DIMENSIONS: { label: string; labelHeader: string; value: Dimension }[] = [
  { label: 'Team', labelHeader: 'Team', value: 'team' },
  { label: 'Organization', labelHeader: 'Organization', value: 'org' },
  { label: 'Model', labelHeader: 'Model', value: 'model' },
  { label: 'Agent', labelHeader: 'Agent', value: 'agent' },
  { label: 'Activity', labelHeader: 'Activity', value: 'activity' },
];

const TOP_N = 10;

type Row = UsageBucket & { label: string };

/** The rows of one breakdown, labelled in words rather than ids. */
function rowsFor(data: PlatformUsage, dimension: Dimension): Row[] {
  switch (dimension) {
    case 'team':
      return data.byTeam.map((r) => ({
        ...r,
        label: r.teamId ? (r.teamName ?? 'Unnamed team') : 'Not attributed to a team',
      }));
    case 'org':
      return data.byOrg.map((r) => ({
        ...r,
        label: r.orgId
          ? (r.orgName ?? 'Unnamed organization')
          : 'Not attributed to an organization',
      }));
    case 'model':
      return data.byModel.map((r) => ({ ...r, label: r.model ?? 'Model not resolved' }));
    case 'agent':
      return data.byAgent.map((r) => ({ ...r, label: humanizeKey(r.agentKey) }));
    case 'activity':
      return data.byActivity.map((r) => ({ ...r, label: humanizeKey(r.nodeId) }));
  }
}

function sortValue(r: Row, key: SortKey): number | string {
  switch (key) {
    case 'label':
      return r.label.toLowerCase();
    case 'calls':
      return r.calls;
    case 'tokens':
      return r.inputTokens + r.outputTokens;
    case 'latency':
      return r.avgDurationMs ?? -1;
    case 'errorRate':
      return errorRate(r) ?? -1;
    case 'cost':
      return r.costUsd;
  }
}

/** One breakdown table: a label column plus the same usage columns every time. */
function BreakdownTable({ dimension, data }: { dimension: Dimension; data: PlatformUsage }) {
  const [sortKey, setSortKey] = useState<SortKey>('cost');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [showAll, setShowAll] = useState(false);
  const labelHeader = DIMENSIONS.find((d) => d.value === dimension)?.labelHeader ?? '';
  const rows = useMemo(() => {
    const sorted = [...rowsFor(data, dimension)].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      const cmp = typeof av === 'string' ? av.localeCompare(String(bv)) : av - (bv as number);
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return sorted;
  }, [data, dimension, sortKey, sortDir]);
  const shown = showAll ? rows : rows.slice(0, TOP_N);

  const sort = (k: SortKey) => {
    if (k === sortKey) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(k);
      setSortDir(k === 'label' ? 'asc' : 'desc');
    }
  };

  if (rows.length === 0) {
    return (
      <EmptyState
        hint="No calls in this window carry this attribution."
        icon="filter"
        title={`Nothing to break down by ${labelHeader.toLowerCase()}`}
      />
    );
  }
  return (
    <div className="overflow-x-auto">
      <DataTable
        className="max-sm:px-4"
        columns={[
          {
            cell: (r) => (
              // A model spec (`anthropic/…`) is an identifier; the other dimensions are names.
              <span
                className={cn(
                  'text-sm',
                  dimension === 'model' && r.label !== 'Model not resolved' && 'font-mono'
                )}
              >
                {r.label}
              </span>
            ),
            header: labelHeader,
            id: 'label',
            label: labelHeader,
            primary: true,
            sortable: true,
          },
          {
            align: 'right',
            cell: (r) => (
              <span className="text-sm text-paper-300 tabular-nums">{formatCount(r.calls)}</span>
            ),
            header: 'Calls',
            id: 'calls',
            sortable: true,
          },
          {
            align: 'right',
            cell: (r) => (
              <span className="text-sm text-paper-300 tabular-nums">
                {formatTokens(r.inputTokens)} / {formatTokens(r.outputTokens)}
              </span>
            ),
            header: 'Tokens in / out',
            id: 'tokens',
            sortable: true,
          },
          {
            align: 'right',
            cell: (r) => (
              <span className="text-sm text-paper-300 tabular-nums">
                {formatDuration(r.avgDurationMs === null ? null : Math.round(r.avgDurationMs))}
              </span>
            ),
            header: 'Avg latency',
            id: 'latency',
            sortable: true,
          },
          {
            align: 'right',
            cell: (r) => (
              <span
                className={cn(
                  'text-sm tabular-nums',
                  r.errors > 0 ? 'text-danger-400' : 'text-paper-300'
                )}
              >
                {formatPercent(errorRate(r))}
              </span>
            ),
            header: 'Error rate',
            id: 'errorRate',
            sortable: true,
          },
          {
            align: 'right',
            cell: (r) => (
              <span className="text-sm font-medium text-paper-100 tabular-nums">
                {formatTotalCost(r.costUsd)}
              </span>
            ),
            header: 'Cost',
            id: 'cost',
            sortable: true,
          },
        ]}
        density="compact"
        getRowId={(r) => r.label}
        onSortChange={(id) => sort(id as SortKey)}
        rows={shown}
        sort={{ columnId: sortKey, direction: sortDir === 'desc' ? 'descending' : 'ascending' }}
      />
      {rows.length > TOP_N && (
        <div className="border-t border-ink-600 px-4 py-2">
          <Button onClick={() => setShowAll((v) => !v)} size="sm" variant="ghost">
            {showAll ? `Show top ${TOP_N}` : `Show all ${rows.length}`}
          </Button>
        </div>
      )}
    </div>
  );
}

function UsageWorkspace() {
  const { params, update } = useUrlFilters();
  const range = parseDateRange(params);
  const windowDays = rangeDays(range);
  const scopeOptions = useScopeOptions();
  const chosenScope = params.get('scope');
  const [dimension, setDimension] = useState<Dimension>('model');
  // Until the caller picks one, the first scope they may read: the whole
  // platform for an ADMIN, their first team (or organization) otherwise.
  const scopeValue =
    chosenScope !== null && scopeOptions?.some((o) => o.value === chosenScope)
      ? chosenScope
      : (scopeOptions?.[0]?.value ?? null);
  const scopes = useUsageScopes();
  const { data, error, isError, isFetching, refetch, isLoading, isPlaceholderData } =
    usePlatformUsage(range, scopeOf(scopeValue ?? ''), scopeValue !== null);
  const scopeLabel = String(scopeOptions?.find((o) => o.value === scopeValue)?.label ?? '');
  const delta = data
    ? formatDelta(data.totals.costUsd, data.previous.costUsd, {
        higherIsBetter: false,
        noun: `vs previous ${windowDays} days`,
      })
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {scopeOptions && scopeOptions.length > 0 && (
              <Select
                appearance="pill"
                aria-label="Scope"
                onChange={(v) => update({ scope: v || null })}
                options={scopeOptions}
                value={scopeValue ?? ''}
              />
            )}
            <DateRangeControl
              onChange={(r) => r && update(dateRangePatch(r))}
              rangeIgnored={customRangeIgnored(params)}
              value={range}
            />
          </div>
        }
        help={
          <p>
            Calls from workflows that keep no run record are included, attributed to the team and
            organization whose spend it is. Days are UTC.
          </p>
        }
        subtitle="Every LLM and embedding call, by team and organization."
        title="LLM usage"
      />

      {scopeOptions?.length === 0 && (
        <EmptyState
          bordered
          hint="Usage is reported to platform admins, team leads and organization admins."
          icon="lock"
          title="You lead no team or organization, so there is no usage you can see."
        />
      )}

      {/* The report query waits on the scopes, so a failed scopes request must show too. */}
      <QueryBoundary
        error={scopes.error}
        isError={scopes.isError}
        isFetching={scopes.isFetching}
        isLoading={scopes.isLoading}
        label="the scopes you can report on"
        onRetry={() => void scopes.refetch()}
        rows={1}
      >
        <QueryBoundary
          error={error}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="LLM usage"
          onRetry={() => void refetch()}
          rows={3}
          shape="cards"
        >
          {data && (
            <div
              aria-busy={isPlaceholderData}
              className={cn('space-y-6 transition-opacity', isPlaceholderData && 'opacity-50')}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-paper-500">
                {scopeLabel && (
                  <p>
                    Showing {scopeLabel.toLowerCase()} for {rangePhrase(range)}.
                  </p>
                )}
                {isPlaceholderData && (
                  <p className="text-paper-400" role="status">
                    Updating…
                  </p>
                )}
              </div>
              <Card className="p-5 sm:p-6">
                <h2 className="sr-only">Headline numbers</h2>
                <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat
                    delta={delta}
                    hint={`Previous ${windowDays} days: ${formatTotalCost(data.previous.costUsd)}`}
                    label="Spend"
                    value={formatTotalCost(data.totals.costUsd)}
                  />
                  <Stat label="LLM calls" value={formatCount(data.totals.calls)} />
                  <Stat
                    label="Error rate"
                    tone={data.totals.errors > 0 ? 'danger' : 'default'}
                    value={formatPercent(errorRate(data.totals))}
                  />
                  <Stat
                    hint="Authoring, scheduled evals, lesson consolidation and other work that keeps no run record"
                    label="Spend outside workflow runs"
                    value={formatTotalCost(data.unattributed.costUsd)}
                  />
                </div>
              </Card>

              {data.totals.calls === 0 ? (
                data.previous.calls === 0 ? (
                  <EmptyState
                    action={
                      <ButtonLink href="/start" size="sm" variant="primary">
                        Start work
                      </ButtonLink>
                    }
                    bordered
                    hint="Usage appears after the first run."
                    icon="coin"
                    title="No LLM calls recorded yet."
                  />
                ) : (
                  <EmptyState
                    bordered
                    hint="Try a longer range or a different scope."
                    icon="coin"
                    title="No LLM calls in this window."
                  />
                )
              ) : (
                <>
                  <Card>
                    <CardHeader>
                      <CardTitle>
                        {data.bucketDays === 7 ? 'Spend per week' : 'Spend per day'}
                      </CardTitle>
                      <span className="text-xs text-paper-500">US dollars · days are UTC</span>
                    </CardHeader>
                    <DailyCostChart
                      data={data.daily}
                      granularity={data.bucketDays === 7 ? 'week' : 'day'}
                      title={data.bucketDays === 7 ? 'LLM spend per week' : 'LLM spend per day'}
                    />
                  </Card>

                  <Card className="overflow-hidden p-0">
                    <CardHeader className="items-center px-4 pt-5">
                      <CardTitle>Where the spend goes</CardTitle>
                      <SegmentedControl
                        ariaLabel="Break down by"
                        onChange={setDimension}
                        options={DIMENSIONS.map(({ label, value }) => ({ label, value }))}
                        value={dimension}
                      />
                    </CardHeader>
                    <BreakdownTable data={data} dimension={dimension} />
                  </Card>

                  <Card className="overflow-hidden p-0">
                    <CardHeader className="px-4 pt-5">
                      <CardTitle>Costliest runs in this window</CardTitle>
                    </CardHeader>
                    <DataTable
                      className="max-sm:px-4"
                      columns={[
                        {
                          cell: (r) => (
                            <span className="font-mono text-sm">
                              {r.externalTicketId ?? r.runId.slice(0, 8)}
                            </span>
                          ),
                          header: 'Run',
                          id: 'run',
                          primary: true,
                        },
                        {
                          cell: (r) => <span className="text-paper-300">{r.templateName}</span>,
                          header: 'Template',
                          id: 'template',
                        },
                        {
                          cell: (r) => <StatusBadge status={r.status} />,
                          header: 'Status',
                          id: 'status',
                        },
                        {
                          align: 'right',
                          cell: (r) => (
                            <span className="text-sm text-paper-300 tabular-nums">
                              {formatTokens(r.inputTokens)} / {formatTokens(r.outputTokens)}
                            </span>
                          ),
                          header: 'Tokens in / out',
                          id: 'tokens',
                        },
                        {
                          align: 'right',
                          cell: (r) => (
                            <span className="text-sm font-medium text-paper-100 tabular-nums">
                              {formatTotalCost(r.costUsd)}
                            </span>
                          ),
                          header: 'Cost',
                          id: 'cost',
                        },
                      ]}
                      density="compact"
                      empty={
                        <EmptyState
                          hint="Runs appear here once their LLM calls are priced."
                          icon="runs"
                          title="No priced runs in this window"
                        />
                      }
                      getRowId={(r) => r.runId}
                      rowHref={(r) => runHref(r.runId)}
                      rows={data.topRuns}
                    />
                  </Card>
                </>
              )}
            </div>
          )}
        </QueryBoundary>
      </QueryBoundary>
    </div>
  );
}

export default function UsagePage() {
  return (
    <Suspense fallback={null}>
      <UsageWorkspace />
    </Suspense>
  );
}
