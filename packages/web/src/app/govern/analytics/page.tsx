'use client';

import Link from 'next/link';
import { Suspense, useMemo, useState } from 'react';
import { WorkflowsOverTimeChart } from '@/components/charts/WorkflowsOverTimeChart';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { DateRangeControl } from '@/components/ui/DateRangeControl';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Stat } from '@/components/ui/Stat';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { useSort } from '@/hooks/useSort';
import { useGlobalAnalytics } from '@/hooks/useTemplates';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import {
  customRangeIgnored,
  dateRangePatch,
  parseDateRange,
  rangeDays,
  rangePhrase,
} from '@/lib/dateRange';
import { formatDelta } from '@/lib/delta';
import { outcomeTypeLabel } from '@/lib/govLabels';
import { successTone } from '@/lib/tone';
import { FOCUS_RING, formatCost, formatDuration, formatPercent } from '@/lib/utils';

type TemplateSort = 'name' | 'runs' | 'successRate' | 'totalCost' | 'avgCost';
type DomainSort =
  | 'domain'
  | 'runs'
  | 'cost'
  | 'timeSaved'
  | 'agentError'
  | 'humanError'
  | 'vsHuman';
type OutcomeSort = 'outcome' | 'runs' | 'cost';

/** Minutes, as the analytics API reports time saved, rendered as a duration. */
function formatMinutes(min: number): string {
  return formatDuration(Math.round(min) * 60_000);
}

function successRateClass(rate: number): string {
  const tone = successTone(rate);
  return tone === 'moss' ? 'text-moss-400' : tone === 'amber' ? 'text-amber-400' : 'text-brick-400';
}

/** The agent's error rate against the human baseline, in percentage points. */
function formatPoints(diff: number): string {
  const pts = diff * 100;
  return `${pts > 0 ? '+' : ''}${pts.toFixed(1)} pts`;
}

const PAGE_SIZE = 25;
/** Fewer baseline cases than this and the comparison with humans is not reliable. */
const MIN_BASELINE_SAMPLE = 30;

function AnalyticsWorkspace() {
  const { params, update } = useUrlFilters();
  const range = parseDateRange(params);
  const windowDays = rangeDays(range);
  const filter = (params.get('q') ?? '').slice(0, 100);
  const [page, setPage] = useState(0);
  const templateSort = useSort<TemplateSort>('runs', { ascendingFirst: ['name'] });
  const domainSort = useSort<DomainSort>('runs', { ascendingFirst: ['domain'] });
  const outcomeSort = useSort<OutcomeSort>('runs', { ascendingFirst: ['outcome'] });
  const { data, isLoading, isError, isFetching, refetch, error } = useGlobalAnalytics(range);

  const rows = useMemo(() => {
    if (!data) {
      return [];
    }
    const filterLower = filter.toLowerCase();
    const filtered = filter
      ? data.perTemplate.filter((r) => r.templateName.toLowerCase().includes(filterLower))
      : data.perTemplate;
    const value = (r: (typeof filtered)[number]): number | string => {
      switch (templateSort.key) {
        case 'name':
          return r.templateName.toLowerCase();
        case 'runs':
          return r.totalRuns;
        case 'successRate':
          return r.successRate ?? -1;
        case 'totalCost':
          return r.totalCost;
        case 'avgCost':
          return r.totalRuns > 0 ? r.totalCost / r.totalRuns : -1;
      }
    };
    return [...filtered].sort((a, b) => templateSort.compare(value(a), value(b)));
  }, [data, filter, templateSort.key, templateSort.compare]);

  const domains = useMemo(() => {
    const value = (d: NonNullable<typeof data>['perDomain'][number]): number | string => {
      switch (domainSort.key) {
        case 'domain':
          return d.domain.toLowerCase();
        case 'runs':
          return d.totalRuns;
        case 'cost':
          return d.totalCost;
        case 'timeSaved':
          return d.estimatedHumanTimeSavedTotal ?? -1;
        case 'agentError':
          return d.agentErrorRate ?? -1;
        case 'humanError':
          return d.humanErrorRate ?? -1;
        case 'vsHuman':
          return d.errorRateVsHuman ?? -999;
      }
    };
    return [...(data?.perDomain ?? [])].sort((a, b) => domainSort.compare(value(a), value(b)));
  }, [data, domainSort.key, domainSort.compare]);

  const outcomes = useMemo(() => {
    const value = (o: NonNullable<typeof data>['perOutcome'][number]): number | string => {
      switch (outcomeSort.key) {
        case 'outcome':
          return outcomeTypeLabel(o.outcomeType).toLowerCase();
        case 'runs':
          return o.runCount;
        case 'cost':
          return o.totalCost;
      }
    };
    return [...(data?.perOutcome ?? [])].sort((a, b) => outcomeSort.compare(value(a), value(b)));
  }, [data, outcomeSort.key, outcomeSort.compare]);

  const totalPages = Math.ceil(rows.length / PAGE_SIZE);
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const noun = `vs previous ${windowDays} days`;
  const prev = data?.previous ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <DateRangeControl
            onChange={(r) => {
              if (r) {
                update(dateRangePatch(r));
                setPage(0);
              }
            }}
            rangeIgnored={customRangeIgnored(params)}
            value={range}
          />
        }
        subtitle="Run volume, outcomes, cost, and time saved across every workflow template on the platform."
        title="Platform analytics"
      />

      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="analytics"
        onRetry={() => void refetch()}
      >
        {!data ? (
          <EmptyState
            bordered
            hint="Analytics appear once workflow runs have been recorded."
            icon="analytics"
            title="No analytics data yet"
          />
        ) : (
          <>
            {data.isTruncated && (
              <Alert variant="warning">
                Results capped at the 10,000 most recent runs. Totals and rates reflect the capped
                window — older runs are omitted.
              </Alert>
            )}

            <Card className="p-5 sm:p-6">
              <h2 className="sr-only">Headline numbers</h2>
              <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
                <Stat
                  delta={
                    prev
                      ? formatDelta(data.totalRuns, prev.totalRuns, { higherIsBetter: null, noun })
                      : null
                  }
                  hint={`${data.completedRuns} finished, ${data.runningRuns} running`}
                  label="Runs"
                  value={data.totalRuns}
                />
                <Stat
                  delta={
                    prev
                      ? formatDelta(data.successRate, prev.successRate, {
                          higherIsBetter: true,
                          noun,
                          unit: 'pp',
                        })
                      : null
                  }
                  hint={`${data.succeeded} succeeded, ${data.failed} failed`}
                  label="Success rate"
                  tone={successTone(data.successRate)}
                  value={formatPercent(data.successRate)}
                />
                <Stat
                  delta={
                    prev
                      ? formatDelta(data.totalCost, prev.totalCost, { higherIsBetter: false, noun })
                      : null
                  }
                  hint={
                    <>
                      Workflow-run spend only.{' '}
                      <Link className="text-ember-400 hover:underline" href="/govern/usage">
                        See all spend
                      </Link>
                    </>
                  }
                  label="Run cost"
                  value={formatCost(data.totalCost)}
                />
                <Stat
                  delta={
                    prev
                      ? formatDelta(
                          data.estimatedHumanTimeSavedTotal ?? 0,
                          prev.estimatedHumanTimeSavedTotal ?? 0,
                          { higherIsBetter: true, noun }
                        )
                      : null
                  }
                  hint="Estimated from each template's expected human effort"
                  label="Time saved (estimate)"
                  tone={(data.estimatedHumanTimeSavedTotal ?? 0) > 0 ? 'moss' : 'default'}
                  value={formatMinutes(data.estimatedHumanTimeSavedTotal ?? 0)}
                />
              </div>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle eyebrow="Volume">Runs over time</CardTitle>
                <span className="text-xs text-paper-500">
                  Per day, stacked by outcome · {rangePhrase(range)}
                </span>
              </CardHeader>
              <WorkflowsOverTimeChart data={data.daily ?? []} title="Workflow runs over time" />
            </Card>

            <Card className="p-5 sm:p-6">
              <h2 className="kicker mb-4">Efficiency</h2>
              <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-3">
                <Stat
                  hint="Average cost of a run in this window"
                  label="Avg cost per run"
                  value={data.totalRuns > 0 ? formatCost(data.totalCost / data.totalRuns) : '—'}
                />
                <Stat
                  hint="Share of finished runs that needed no human step"
                  label="Autonomy rate"
                  value={formatPercent(data.autonomyRate)}
                />
                <Stat
                  hint="Share of finished runs where a person reviewed or approved"
                  label="Human review rate"
                  value={formatPercent(data.humanReviewRate)}
                />
              </div>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle eyebrow="Templates">Ranked by traffic</CardTitle>
              </CardHeader>
              <Toolbar
                end={
                  rows.length > 0 && (
                    <span className="text-xs text-paper-500 tabular-nums">
                      {rows.length} template{rows.length === 1 ? '' : 's'}
                    </span>
                  )
                }
              >
                <SearchInput
                  label="Filter templates by name"
                  onChange={(v) => {
                    update({ q: v || null });
                    setPage(0);
                  }}
                  placeholder="Filter templates…"
                  value={filter}
                />
              </Toolbar>
              {rows.length === 0 ? (
                filter ? (
                  <EmptyState
                    action={
                      <Button onClick={() => update({ q: null })} size="sm">
                        Clear filter
                      </Button>
                    }
                    hint={`Nothing matches “${filter}”.`}
                    icon="search"
                    title="No templates match your filter"
                  />
                ) : (
                  <EmptyState
                    action={
                      <ButtonLink href="/workflows/library" size="sm">
                        Browse workflow library
                      </ButtonLink>
                    }
                    hint="Templates appear here, ranked by run count, once they have run."
                    icon="templates"
                    title={`No runs in ${rangePhrase(range)}`}
                  />
                )
              ) : (
                <>
                  <div className="-mx-4">
                    <Table>
                      <THead>
                        <Th
                          onSort={() => templateSort.toggle('name')}
                          sort={templateSort.direction('name')}
                          variant="dense"
                        >
                          Template
                        </Th>
                        <Th
                          align="right"
                          onSort={() => templateSort.toggle('runs')}
                          sort={templateSort.direction('runs')}
                          variant="dense"
                        >
                          Runs
                        </Th>
                        <Th
                          align="right"
                          onSort={() => templateSort.toggle('successRate')}
                          sort={templateSort.direction('successRate')}
                          variant="dense"
                        >
                          Success rate
                        </Th>
                        <Th
                          align="right"
                          onSort={() => templateSort.toggle('totalCost')}
                          sort={templateSort.direction('totalCost')}
                          variant="dense"
                        >
                          Total cost
                        </Th>
                        <Th
                          align="right"
                          onSort={() => templateSort.toggle('avgCost')}
                          sort={templateSort.direction('avgCost')}
                          variant="dense"
                        >
                          Avg cost per run
                        </Th>
                      </THead>
                      <tbody>
                        {pageRows.map((row) => {
                          const avgCost = row.totalRuns > 0 ? row.totalCost / row.totalRuns : null;
                          return (
                            <TRow hover key={row.templateId}>
                              <Td className="px-4 py-2.5">
                                <Link
                                  className={`rounded-sm font-medium text-paper-100 hover:text-ember-300 ${FOCUS_RING}`}
                                  href={`/workflows/library/${row.templateId}`}
                                >
                                  {row.templateName}
                                </Link>
                              </Td>
                              <Td className="px-4 py-2 text-right tabular-nums">{row.totalRuns}</Td>
                              <Td className="px-4 py-2 text-right tabular-nums">
                                {row.successRate !== null ? (
                                  <span className={successRateClass(row.successRate)}>
                                    {formatPercent(row.successRate)}
                                  </span>
                                ) : (
                                  '—'
                                )}
                              </Td>
                              <Td className="px-4 py-2 text-right tabular-nums">
                                {formatCost(row.totalCost)}
                              </Td>
                              <Td className="px-4 py-2 text-right tabular-nums">
                                {avgCost !== null ? formatCost(avgCost) : '—'}
                              </Td>
                            </TRow>
                          );
                        })}
                      </tbody>
                    </Table>
                  </div>
                  {totalPages > 1 && (
                    <Pagination
                      hasNext={page < totalPages - 1}
                      hasPrev={page > 0}
                      onNext={() => setPage((p) => p + 1)}
                      onPrev={() => setPage((p) => p - 1)}
                      rangeEnd={Math.min((page + 1) * PAGE_SIZE, rows.length)}
                      rangeStart={rows.length === 0 ? 0 : page * PAGE_SIZE + 1}
                      total={rows.length}
                    />
                  )}
                </>
              )}
            </Card>

            {domains.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle eyebrow="Breakdown">By domain</CardTitle>
                  <span className="text-xs text-paper-500">
                    Agent vs human compares error rates, in percentage points
                  </span>
                </CardHeader>
                <div className="-mx-4">
                  <Table className="max-sm:px-4" stacked>
                    <THead>
                      <Th
                        onSort={() => domainSort.toggle('domain')}
                        sort={domainSort.direction('domain')}
                        variant="dense"
                      >
                        Domain
                      </Th>
                      <Th
                        align="right"
                        onSort={() => domainSort.toggle('runs')}
                        sort={domainSort.direction('runs')}
                        variant="dense"
                      >
                        Runs
                      </Th>
                      <Th
                        align="right"
                        onSort={() => domainSort.toggle('cost')}
                        sort={domainSort.direction('cost')}
                        variant="dense"
                      >
                        Total cost
                      </Th>
                      <Th
                        align="right"
                        onSort={() => domainSort.toggle('timeSaved')}
                        sort={domainSort.direction('timeSaved')}
                        variant="dense"
                      >
                        Time saved
                      </Th>
                      <Th
                        align="right"
                        onSort={() => domainSort.toggle('agentError')}
                        sort={domainSort.direction('agentError')}
                        variant="dense"
                      >
                        Agent error rate
                      </Th>
                      <Th
                        align="right"
                        onSort={() => domainSort.toggle('humanError')}
                        sort={domainSort.direction('humanError')}
                        variant="dense"
                      >
                        Human error rate
                      </Th>
                      <Th
                        align="right"
                        onSort={() => domainSort.toggle('vsHuman')}
                        sort={domainSort.direction('vsHuman')}
                        variant="dense"
                      >
                        <span title="Agent error rate minus the human baseline, in percentage points. Needs at least 30 baseline cases.">
                          Agent vs human
                        </span>
                      </Th>
                    </THead>
                    <tbody>
                      {domains.map((d) => (
                        <TRow key={d.domain}>
                          <Td className="px-4 py-2.5 font-medium text-paper-100" primary>
                            {outcomeTypeLabel(d.domain)}
                          </Td>
                          <Td className="px-4 py-2 text-right tabular-nums" label="Runs">
                            {d.totalRuns}
                          </Td>
                          <Td className="px-4 py-2 text-right tabular-nums" label="Total cost">
                            {formatCost(d.totalCost)}
                          </Td>
                          <Td className="px-4 py-2 text-right tabular-nums" label="Time saved">
                            {d.estimatedHumanTimeSavedTotal != null
                              ? formatMinutes(d.estimatedHumanTimeSavedTotal)
                              : '—'}
                          </Td>
                          <Td
                            className="px-4 py-2 text-right tabular-nums"
                            label="Agent error rate"
                          >
                            {formatPercent(d.agentErrorRate ?? null)}
                          </Td>
                          <Td
                            className="px-4 py-2 text-right tabular-nums"
                            label="Human error rate"
                          >
                            {formatPercent(d.humanErrorRate ?? null)}
                          </Td>
                          <Td className="px-4 py-2 text-right tabular-nums" label="Agent vs human">
                            {d.errorRateVsHuman != null ? (
                              // Positive means the agent errs more than the human baseline.
                              <span
                                className={
                                  d.errorRateVsHuman > 0 ? 'text-brick-400' : 'text-moss-400'
                                }
                              >
                                {formatPoints(d.errorRateVsHuman)}
                              </span>
                            ) : d.baselineSampleSize != null &&
                              d.baselineSampleSize < MIN_BASELINE_SAMPLE ? (
                              <span
                                className="text-xs text-paper-400"
                                title={`Only ${d.baselineSampleSize} baseline cases; at least ${MIN_BASELINE_SAMPLE} are needed to compare.`}
                              >
                                Too few baseline cases ({d.baselineSampleSize})
                              </span>
                            ) : (
                              '—'
                            )}
                          </Td>
                        </TRow>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </Card>
            )}

            {outcomes.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle eyebrow="Breakdown">By outcome</CardTitle>
                </CardHeader>
                <div className="-mx-4">
                  <Table>
                    <THead>
                      <Th
                        onSort={() => outcomeSort.toggle('outcome')}
                        sort={outcomeSort.direction('outcome')}
                        variant="dense"
                      >
                        Outcome
                      </Th>
                      <Th
                        align="right"
                        onSort={() => outcomeSort.toggle('runs')}
                        sort={outcomeSort.direction('runs')}
                        variant="dense"
                      >
                        Runs
                      </Th>
                      <Th
                        align="right"
                        onSort={() => outcomeSort.toggle('cost')}
                        sort={outcomeSort.direction('cost')}
                        variant="dense"
                      >
                        Total cost
                      </Th>
                    </THead>
                    <tbody>
                      {outcomes.map((o) => (
                        <TRow key={o.outcomeType}>
                          <Td className="px-4 py-2.5 font-medium text-paper-100">
                            {outcomeTypeLabel(o.outcomeType)}
                          </Td>
                          <Td className="px-4 py-2 text-right tabular-nums">{o.runCount}</Td>
                          <Td className="px-4 py-2 text-right tabular-nums">
                            {formatCost(o.totalCost)}
                          </Td>
                        </TRow>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </Card>
            )}
          </>
        )}
      </QueryBoundary>
    </div>
  );
}

export default function GlobalAnalyticsPage() {
  return (
    <Suspense fallback={null}>
      <AnalyticsWorkspace />
    </Suspense>
  );
}
