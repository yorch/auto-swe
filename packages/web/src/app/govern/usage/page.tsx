'use client';

import Link from 'next/link';
import { Suspense, useMemo, useState } from 'react';
import { DailyCostChart } from '@/components/charts/DailyCostChart';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { DateRangeControl } from '@/components/ui/DateRangeControl';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select, type SelectOption } from '@/components/ui/Select';
import { Stat } from '@/components/ui/Stat';
import { StatusBadge } from '@/components/ui/StatusBadge';
import {
  type SortDirection,
  Table,
  TableStatusRow,
  Td,
  THead,
  Th,
  TRow,
} from '@/components/ui/Table';
import {
  type PlatformUsage,
  type UsageBucket,
  type UsageScope,
  usePlatformUsage,
  useUsageScopes,
} from '@/hooks/useAdmin';
import { useUrlParams } from '@/hooks/useUrlParams';
import { dateRangePatch, parseDateRange } from '@/lib/dateRange';
import { formatDelta } from '@/lib/delta';
import { humanizeKey } from '@/lib/govLabels';
import { formatCost, formatCount, formatDuration, formatPercent, formatTokens } from '@/lib/utils';

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
  const dir = (k: SortKey): SortDirection =>
    k !== sortKey ? 'none' : sortDir === 'desc' ? 'descending' : 'ascending';

  if (rows.length === 0) {
    return <EmptyState title={`Nothing to break down by ${labelHeader.toLowerCase()}.`} />;
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <THead className="bg-ink-800">
          <Th onSort={() => sort('label')} sort={dir('label')} variant="plain">
            {labelHeader}
          </Th>
          <Th align="right" onSort={() => sort('calls')} sort={dir('calls')} variant="plain">
            Calls
          </Th>
          <Th align="right" onSort={() => sort('tokens')} sort={dir('tokens')} variant="plain">
            Tokens in / out
          </Th>
          <Th align="right" onSort={() => sort('latency')} sort={dir('latency')} variant="plain">
            Avg latency
          </Th>
          <Th
            align="right"
            onSort={() => sort('errorRate')}
            sort={dir('errorRate')}
            variant="plain"
          >
            Error rate
          </Th>
          <Th align="right" onSort={() => sort('cost')} sort={dir('cost')} variant="plain">
            Cost
          </Th>
        </THead>
        <tbody>
          {shown.map((r) => (
            <TRow key={r.label}>
              <Td className="px-4 py-2 text-sm text-paper-200">{r.label}</Td>
              <Td align="right" className="px-4 py-2 font-mono text-xs text-paper-400">
                {formatCount(r.calls)}
              </Td>
              <Td align="right" className="px-4 py-2 font-mono text-xs text-paper-400">
                {formatTokens(r.inputTokens)} / {formatTokens(r.outputTokens)}
              </Td>
              <Td align="right" className="px-4 py-2 font-mono text-xs text-paper-400">
                {formatDuration(r.avgDurationMs === null ? null : Math.round(r.avgDurationMs))}
              </Td>
              <Td
                align="right"
                className={`px-4 py-2 font-mono text-xs ${r.errors > 0 ? 'text-brick-400' : 'text-paper-400'}`}
              >
                {formatPercent(errorRate(r))}
              </Td>
              <Td align="right" className="px-4 py-2 font-mono text-xs text-paper-200">
                {formatCost(r.costUsd)}
              </Td>
            </TRow>
          ))}
        </tbody>
      </Table>
      {rows.length > TOP_N && (
        <div className="border-t border-ink-500 px-4 py-2">
          <Button onClick={() => setShowAll((v) => !v)} size="sm" variant="ghost">
            {showAll ? `Show top ${TOP_N}` : `Show all ${rows.length}`}
          </Button>
        </div>
      )}
    </div>
  );
}

function UsageWorkspace() {
  const { params, update } = useUrlParams();
  const range = parseDateRange(params);
  const windowDays = range.kind === 'preset' ? range.days : 30;
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
  const { data, error, isError, isLoading, isPlaceholderData } = usePlatformUsage(
    windowDays,
    scopeOf(scopeValue ?? ''),
    scopeValue !== null
  );
  const scopeLabel = String(scopeOptions?.find((o) => o.value === scopeValue)?.label ?? '');
  const delta = data
    ? formatDelta(data.totals.costUsd, data.previous.costUsd, {
        higherIsBetter: false,
        noun: `vs previous ${windowDays} days`,
      })
    : null;

  return (
    <div className="space-y-8">
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
              allowCustom={false}
              onChange={(r) => r && update(dateRangePatch(r))}
              value={range}
            />
          </div>
        }
        chapter="§ Govern"
        subtitle="Every LLM and embedding call, including workflows that keep no run record, attributed to the team and organization whose spend it is. Days are UTC."
        title="LLM usage"
      />

      {scopeOptions?.length === 0 && (
        <EmptyState title="You lead no team or organization, so there is no usage you can see." />
      )}

      {/* The report query waits on the scopes, so a failed scopes request must show too. */}
      <QueryBoundary
        error={scopes.error}
        isError={scopes.isError}
        isLoading={scopes.isLoading}
        label="the scopes you can report on"
      >
        <QueryBoundary error={error} isError={isError} isLoading={isLoading} label="LLM usage">
          {data && (
            <div
              aria-busy={isPlaceholderData}
              className={
                isPlaceholderData ? 'space-y-8 opacity-50 transition-opacity' : 'space-y-8'
              }
            >
              {isPlaceholderData && (
                <p className="font-mono text-xs text-paper-400" role="status">
                  Updating…
                </p>
              )}
              {scopeLabel && (
                <p className="text-xs text-paper-500">
                  Showing {scopeLabel.toLowerCase()} for the last {windowDays} days.
                </p>
              )}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
                <Stat
                  delta={delta}
                  hint={`Previous ${windowDays} days: ${formatCost(data.previous.costUsd)}`}
                  label="Spend"
                  tone="ember"
                  value={formatCost(data.totals.costUsd)}
                />
                <Stat label="LLM calls" value={formatCount(data.totals.calls)} />
                <Stat
                  label="Error rate"
                  tone={data.totals.errors > 0 ? 'brick' : 'default'}
                  value={formatPercent(errorRate(data.totals))}
                />
                <Stat
                  hint="Authoring, scheduled evals, lesson consolidation and other work that keeps no run record"
                  label="Spend outside workflow runs"
                  value={formatCost(data.unattributed.costUsd)}
                />
              </div>

              {data.totals.calls === 0 ? (
                <EmptyState
                  hint="Try a longer range or a different scope."
                  title="No LLM calls in this window."
                />
              ) : (
                <>
                  <Card>
                    <CardHeader>
                      <CardTitle>Spend per day</CardTitle>
                    </CardHeader>
                    <DailyCostChart data={data.daily} />
                  </Card>

                  <Card className="p-0 overflow-hidden">
                    <CardHeader className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4">
                      <CardTitle>Spend breakdown</CardTitle>
                      <SegmentedControl
                        ariaLabel="Break down by"
                        onChange={setDimension}
                        options={DIMENSIONS.map(({ label, value }) => ({ label, value }))}
                        value={dimension}
                      />
                    </CardHeader>
                    <BreakdownTable data={data} dimension={dimension} />
                  </Card>

                  <Card className="p-0 overflow-hidden">
                    <CardHeader className="px-4 pt-4">
                      <CardTitle>Costliest runs in this window</CardTitle>
                    </CardHeader>
                    <Table>
                      <THead className="bg-ink-800">
                        <Th variant="plain">Run</Th>
                        <Th variant="plain">Template</Th>
                        <Th variant="plain">Status</Th>
                        <Th align="right" variant="plain">
                          Tokens in / out
                        </Th>
                        <Th align="right" variant="plain">
                          Cost
                        </Th>
                      </THead>
                      <tbody>
                        {data.topRuns.length === 0 && (
                          <TableStatusRow colSpan={5}>
                            <EmptyState title="No priced runs in this window." />
                          </TableStatusRow>
                        )}
                        {data.topRuns.map((r) => (
                          <TRow hover key={r.runId}>
                            <Td className="px-4 py-2">
                              <Link
                                className="text-ember-400 hover:underline"
                                href={`/runs/${r.runId}`}
                              >
                                {r.externalTicketId ?? r.runId.slice(0, 8)}
                              </Link>
                            </Td>
                            <Td className="px-4 py-2 text-paper-400">{r.templateName}</Td>
                            <Td className="px-4 py-2">
                              <StatusBadge status={r.status} />
                            </Td>
                            <Td
                              align="right"
                              className="px-4 py-2 font-mono text-xs text-paper-400"
                            >
                              {formatTokens(r.inputTokens)} / {formatTokens(r.outputTokens)}
                            </Td>
                            <Td
                              align="right"
                              className="px-4 py-2 font-mono text-xs text-paper-200"
                            >
                              {formatCost(r.costUsd)}
                            </Td>
                          </TRow>
                        ))}
                      </tbody>
                    </Table>
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
