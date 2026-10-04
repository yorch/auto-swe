'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Stat } from '@/components/ui/Stat';
import { type SortDirection, Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useGlobalAnalytics } from '@/hooks/useTemplates';
import { formatCost, formatDuration, formatPercent } from '@/lib/utils';

const WINDOWS = [
  { label: '7d', value: '7' },
  { label: '30d', value: '30' },
  { label: '90d', value: '90' },
];

type SortKey = 'runs' | 'successRate' | 'totalCost' | 'avgCost';

/** Minutes, as the analytics API reports time saved, rendered as a duration. */
function formatMinutes(min: number): string {
  return formatDuration(Math.round(min) * 60_000);
}

/** Text colour for a 0–1 success rate. */
function successRateClass(rate: number): string {
  if (rate >= 0.8) {
    return 'text-moss-400';
  }
  return rate >= 0.5 ? 'text-amber-400' : 'text-brick-400';
}

const PAGE_SIZE = 25;

export default function GlobalAnalyticsPage() {
  const [windowDays, setWindowDays] = useState(30);
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('runs');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);
  const { data, isLoading, isError, refetch, error } = useGlobalAnalytics(windowDays);

  const handleSort = (k: SortKey) => {
    if (k === sortKey) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(k);
      setSortDir('desc');
    }
    setPage(0);
  };

  const sortDirection = (k: SortKey): SortDirection =>
    k !== sortKey ? 'none' : sortDir === 'desc' ? 'descending' : 'ascending';

  const handleFilter = (v: string) => {
    setFilter(v);
    setPage(0);
  };

  const rows = useMemo(() => {
    if (!data) {
      return [];
    }
    const filterLower = filter.toLowerCase();
    const filtered = filter
      ? data.perTemplate.filter((r) => r.templateName.toLowerCase().includes(filterLower))
      : data.perTemplate;
    return [...filtered].sort((a, b) => {
      let av: number;
      let bv: number;
      if (sortKey === 'runs') {
        av = a.totalRuns;
        bv = b.totalRuns;
      } else if (sortKey === 'successRate') {
        av = a.successRate ?? -1;
        bv = b.successRate ?? -1;
      } else if (sortKey === 'totalCost') {
        av = a.totalCost;
        bv = b.totalCost;
      } else {
        av = a.totalRuns > 0 ? a.totalCost / a.totalRuns : -1;
        bv = b.totalRuns > 0 ? b.totalCost / b.totalRuns : -1;
      }
      return sortDir === 'desc' ? bv - av : av - bv;
    });
  }, [data, filter, sortKey, sortDir]);

  const totalPages = Math.ceil(rows.length / PAGE_SIZE);
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="space-y-8">
      <PageHeader
        actions={
          <SegmentedControl
            ariaLabel="Time window"
            onChange={(v) => {
              setWindowDays(Number(v));
              setPage(0);
            }}
            options={WINDOWS}
            value={String(windowDays)}
          />
        }
        chapter="§ Govern"
        subtitle="Run volume, outcomes, cost, and time saved across every workflow template on the platform."
        title="Platform analytics"
      />

      <QueryBoundary
        error={error}
        isError={isError}
        isLoading={isLoading}
        label="analytics"
        onRetry={() => void refetch()}
      >
        {!data ? (
          <EmptyState title="No analytics data available." />
        ) : (
          <>
            {data.isTruncated && (
              <Alert variant="warning">
                Results capped at the 10,000 most recent runs. Totals and rates reflect the capped
                window — older runs are omitted.
              </Alert>
            )}

            <div className="grid grid-cols-2 gap-y-8 lg:grid-cols-4">
              <Stat label="Total runs" value={data.totalRuns} />
              <Stat label="Completed runs" value={data.completedRuns} />
              <Stat label="Running runs" value={data.runningRuns} />
              <Stat
                label="Success rate (completed)"
                tone="moss"
                value={formatPercent(data.successRate)}
              />
              <Stat label="Succeeded" tone="moss" value={data.succeeded} />
              <Stat label="Failed" tone="brick" value={data.failed} />
              <Stat label="Total cost" value={formatCost(data.totalCost)} />
              <Stat
                label="Avg cost/run"
                value={data.totalRuns > 0 ? formatCost(data.totalCost / data.totalRuns) : '—'}
              />
              <Stat
                label="Time saved"
                tone="moss"
                value={formatMinutes(data.estimatedHumanTimeSavedTotal ?? 0)}
              />
              <Stat label="Autonomy rate" value={formatPercent(data.autonomyRate)} />
              <Stat label="Human review rate" value={formatPercent(data.humanReviewRate)} />
            </div>

            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Templates — ranked by traffic</CardTitle>
                  <div className="w-48">
                    <Input
                      aria-label="Filter templates by name"
                      compact
                      onChange={(e) => handleFilter(e.target.value)}
                      placeholder="Filter templates…"
                      type="text"
                      value={filter}
                    />
                  </div>
                </div>
              </CardHeader>
              {rows.length === 0 ? (
                <EmptyState
                  title={
                    filter
                      ? 'No templates match your filter.'
                      : `No runs in the last ${windowDays} days.`
                  }
                />
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <Table>
                      <THead className="text-left text-xs text-paper-400">
                        <Th variant="dense">Template</Th>
                        <Th
                          align="right"
                          onSort={() => handleSort('runs')}
                          sort={sortDirection('runs')}
                          variant="dense"
                        >
                          Runs
                        </Th>
                        <Th
                          align="right"
                          onSort={() => handleSort('successRate')}
                          sort={sortDirection('successRate')}
                          variant="dense"
                        >
                          Success rate
                        </Th>
                        <Th
                          align="right"
                          onSort={() => handleSort('totalCost')}
                          sort={sortDirection('totalCost')}
                          variant="dense"
                        >
                          Total cost
                        </Th>
                        <Th
                          align="right"
                          onSort={() => handleSort('avgCost')}
                          sort={sortDirection('avgCost')}
                          variant="dense"
                        >
                          Avg cost/run
                        </Th>
                      </THead>
                      <tbody>
                        {pageRows.map((row) => {
                          const avgCost = row.totalRuns > 0 ? row.totalCost / row.totalRuns : null;
                          return (
                            <TRow hover key={row.templateId}>
                              <Td className="px-4 py-2">
                                <Link
                                  className="text-ember-400 hover:underline"
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

            {data.perDomain.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>By domain</CardTitle>
                </CardHeader>
                <div className="overflow-x-auto">
                  <Table>
                    <THead className="text-left text-xs text-paper-400">
                      <Th variant="dense">Domain</Th>
                      <Th align="right" variant="dense">
                        Runs
                      </Th>
                      <Th align="right" variant="dense">
                        Total cost
                      </Th>
                      <Th align="right" variant="dense">
                        Time saved
                      </Th>
                      <Th align="right" variant="dense">
                        Agent error
                      </Th>
                      <Th align="right" variant="dense">
                        Human error
                      </Th>
                      <Th align="right" variant="dense">
                        vs human
                      </Th>
                    </THead>
                    <tbody>
                      {data.perDomain.map((d) => (
                        <TRow key={d.domain}>
                          <Td className="px-4 py-2">{d.domain}</Td>
                          <Td className="px-4 py-2 text-right tabular-nums">{d.totalRuns}</Td>
                          <Td className="px-4 py-2 text-right tabular-nums">
                            {formatCost(d.totalCost)}
                          </Td>
                          <Td className="px-4 py-2 text-right tabular-nums">
                            {d.estimatedHumanTimeSavedTotal != null
                              ? formatMinutes(d.estimatedHumanTimeSavedTotal)
                              : '—'}
                          </Td>
                          <Td className="px-4 py-2 text-right tabular-nums">
                            {formatPercent(d.agentErrorRate ?? null)}
                          </Td>
                          <Td className="px-4 py-2 text-right tabular-nums">
                            {formatPercent(d.humanErrorRate ?? null)}
                          </Td>
                          <Td className="px-4 py-2 text-right tabular-nums">
                            {d.errorRateVsHuman != null ? (
                              // Percentage points — no shared formatter carries the "pp" unit.
                              `${(d.errorRateVsHuman * 100).toFixed(1)}pp`
                            ) : d.baselineSampleSize != null && d.baselineSampleSize < 30 ? (
                              <span className="text-paper-400" title="Baseline sample too small">
                                n={d.baselineSampleSize}
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

            {data.perOutcome.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>By outcome</CardTitle>
                </CardHeader>
                <div className="overflow-x-auto">
                  <Table>
                    <THead className="text-left text-xs text-paper-400">
                      <Th variant="dense">Outcome</Th>
                      <Th align="right" variant="dense">
                        Runs
                      </Th>
                      <Th align="right" variant="dense">
                        Total cost
                      </Th>
                    </THead>
                    <tbody>
                      {data.perOutcome.map((o) => (
                        <TRow key={o.outcomeType}>
                          <Td className="px-4 py-2">{o.outcomeType}</Td>
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
