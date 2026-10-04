'use client';

import { use, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { GRID_STROKE, TOOLTIP_CURSOR_FILL } from '@/components/charts/chartChrome';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Stat } from '@/components/ui/Stat';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  TemplateBackLink,
  TemplateNotFound,
  TemplateSubNav,
} from '@/components/workflow/templateNav';
import { VersionTags } from '@/components/workflow/VersionTags';
import { useWorkflowTemplate, useWorkflowTemplateAnalytics } from '@/hooks/useTemplates';
import { TOKEN } from '@/lib/palette';
import { validateRouteParam } from '@/lib/routeParams';
import { cn, formatCost, formatDuration, formatPercent } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

const WINDOWS = [7, 14, 30, 90] as const;

export default function TemplateAnalyticsPage({ params }: PageProps) {
  const { id: rawId } = use(params);
  const id = validateRouteParam(rawId);
  const [windowDays, setWindowDays] = useState<number>(30);
  const { data: template } = useWorkflowTemplate(id ?? '');
  const {
    data: stats,
    error,
    isError,
    refetch,
    isLoading,
  } = useWorkflowTemplateAnalytics(id ?? '', windowDays);

  // Sections in render order — numbered from this one list so a conditional
  // section never leaves a gap or a duplicate.
  const sections = stats
    ? [
        stats.perStepFailureRates.length > 0 && 'failures',
        stats.significanceHint && 'significance',
        stats.perVersionCounts.length > 1 && 'versions',
        stats.perOutcome.length > 0 && 'outcomes',
        'detail',
      ].filter(Boolean)
    : [];
  const sectionNumber = (key: string) => String(sections.indexOf(key) + 1).padStart(2, '0');

  if (!id) {
    return <TemplateNotFound />;
  }

  return (
    <div className="space-y-8">
      <div>
        <TemplateBackLink href={`/workflows/library/${id}`} label={template?.name ?? 'Workflow'} />
        <PageHeader
          actions={
            <Select
              className="w-auto"
              compact
              id="window"
              label="Window"
              onChange={(v) => setWindowDays(Number(v))}
              options={WINDOWS.map((w) => ({ label: `${w}d`, value: String(w) }))}
              value={String(windowDays)}
            />
          }
          chapter="§ Workflows"
          className="mb-0 mt-4"
          subtitle={`Observed performance and cost metrics for this workflow over the last ${windowDays} days.`}
          title="Observed performance"
        />
      </div>

      <TemplateSubNav active="analytics" templateId={id} />

      <QueryBoundary
        error={error}
        isError={isError}
        isLoading={!isError && (isLoading || !stats)}
        label="analytics"
        loadingMessage="loading analytics…"
        onRetry={() => void refetch()}
      >
        {stats && (
          <>
            {stats.isTruncated && (
              <Alert variant="warning">
                Analytics are limited to the most recent 10,000 runs or steps in this window.
              </Alert>
            )}
            <section className="grid grid-cols-2 gap-y-8 border-y border-ink-600 py-8 sm:grid-cols-4">
              <Stat label="Total runs" tone="ember" unit="runs" value={stats.totalRuns} />
              <Stat label="Success rate" tone="moss" value={formatPercent(stats.successRate)} />
              <Stat label="p50 duration" value={formatDuration(stats.p50DurationMs)} />
              <Stat label="p95 duration" value={formatDuration(stats.p95DurationMs)} />
              <Stat label="Avg cost / run" tone="amber" value={formatCost(stats.avgCostPerRun)} />
              <Stat label="Total cost" value={formatCost(stats.totalCost)} />
              <Stat label="Succeeded" tone="moss" value={stats.succeeded} />
              <Stat label="Failed" tone="brick" value={stats.failed} />
              <Stat
                label="Time saved"
                tone="moss"
                value={
                  stats.estimatedHumanTimeSavedTotal == null
                    ? '—'
                    : formatDuration(stats.estimatedHumanTimeSavedTotal * 60_000)
                }
              />
              <Stat label="Autonomy rate" value={formatPercent(stats.autonomyRate)} />
              <Stat label="Human review rate" value={formatPercent(stats.humanReviewRate)} />
            </section>

            {/* Per-step failure rate chart */}
            {stats.perStepFailureRates.length > 0 && (
              <section>
                <SectionHeader
                  hint="sorted by failure rate"
                  number={sectionNumber('failures')}
                  title="Step failure rates"
                />
                <Card>
                  <p className="mb-6 text-xs text-paper-400">
                    Failure rate per node across all executions in this window. Skipped and pending
                    excluded.
                  </p>
                  <ResponsiveContainer
                    height={Math.max(180, stats.perStepFailureRates.length * 36)}
                    width="100%"
                  >
                    <BarChart
                      data={[...stats.perStepFailureRates]
                        .sort((a, b) => b.failureRate - a.failureRate)
                        .map((r) => ({
                          failureRate: r.failureRate,
                          name: r.nodeId,
                          total: r.total,
                        }))}
                      layout="vertical"
                      margin={{ bottom: 0, left: 0, right: 40, top: 0 }}
                    >
                      <CartesianGrid
                        horizontal={false}
                        stroke={GRID_STROKE}
                        strokeDasharray="3 3"
                      />
                      <XAxis
                        domain={[0, 1]}
                        tick={{ fill: TOKEN.paper500, fontFamily: 'monospace', fontSize: 10 }}
                        tickFormatter={(v: number) => formatPercent(v)}
                        type="number"
                      />
                      <YAxis
                        dataKey="name"
                        tick={{ fill: TOKEN.paper400, fontFamily: 'monospace', fontSize: 11 }}
                        type="category"
                        width={110}
                      />
                      <Tooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) {
                            return null;
                          }
                          const d = payload[0]?.payload as {
                            name: string;
                            failureRate: number;
                            total: number;
                          };
                          return (
                            <div className="rounded border border-ink-500 bg-ink-800 px-3 py-2 font-mono text-xs text-paper-200 shadow-lg">
                              <div className="font-medium">{d.name}</div>
                              <div className="mt-1 text-paper-400">
                                {formatPercent(d.failureRate)} failure · {d.total} runs
                              </div>
                            </div>
                          );
                        }}
                        cursor={{ fill: TOOLTIP_CURSOR_FILL }}
                      />
                      <Bar dataKey="failureRate" fill={TOKEN.brick400} radius={[0, 3, 3, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </Card>
              </section>
            )}

            {stats.significanceHint && (
              <section>
                <SectionHeader
                  hint="two-proportion z-test"
                  number={sectionNumber('significance')}
                  title="A/B significance"
                />
                <Card>
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-xs text-paper-400">
                      Success-rate comparison between the two most-trafficked versions. Treat this
                      as a hint, not a verdict — apply your own judgement before promoting.
                    </p>
                    <Badge
                      tone={stats.significanceHint.isSignificant ? 'moss' : 'amber'}
                      uppercase
                      variant="outline"
                    >
                      {stats.significanceHint.isSignificant
                        ? 'Winner detected'
                        : 'Not yet significant'}{' '}
                      · p=
                      {typeof stats.significanceHint.pValue === 'number'
                        ? stats.significanceHint.pValue.toFixed(3)
                        : '—'}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-x-8 gap-y-4 border-t border-ink-600 pt-4">
                    <VersionComparison
                      active={stats.significanceHint.versionA === template?.activeVersion}
                      n={stats.significanceHint.nA}
                      rate={stats.significanceHint.successRateA}
                      version={stats.significanceHint.versionA}
                    />
                    <VersionComparison
                      experiment={stats.significanceHint.versionB === template?.experimentVersion}
                      n={stats.significanceHint.nB}
                      rate={stats.significanceHint.successRateB}
                      version={stats.significanceHint.versionB}
                    />
                  </div>
                </Card>
              </section>
            )}

            {stats.perVersionCounts.length > 1 && (
              <section>
                <SectionHeader
                  hint="traffic split"
                  number={sectionNumber('versions')}
                  title="Per-version run mix"
                />
                <Card>
                  <p className="mb-4 text-xs text-paper-400">
                    Useful for confirming the A/B traffic split is landing where you configured it.
                  </p>
                  <ul className="space-y-2">
                    {stats.perVersionCounts.map((v) => (
                      <li
                        className="flex items-center justify-between border-b border-ink-600 pb-2 last:border-b-0 last:pb-0"
                        key={v.version}
                      >
                        <span className="flex items-baseline gap-2 font-mono text-sm">
                          <span className="text-paper-100">v{v.version}</span>
                          <VersionTags
                            active={v.version === template?.activeVersion}
                            experiment={v.version === template?.experimentVersion}
                          />
                        </span>
                        <span className="tabular font-mono text-xs text-paper-300">
                          {v.count}
                          <span className="ml-2 text-paper-500">
                            ({formatPercent(stats.totalRuns > 0 ? v.count / stats.totalRuns : 0)})
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              </section>
            )}

            {stats.perOutcome.length > 0 && (
              <section>
                <SectionHeader
                  hint="cost by outcome"
                  number={sectionNumber('outcomes')}
                  title="Outcomes"
                />
                <Card>
                  <p className="mb-4 text-xs text-paper-400">
                    Runs grouped by the type of outcome they produced.
                  </p>
                  <ul className="space-y-2">
                    {stats.perOutcome.map((o) => (
                      <li
                        className="flex items-center justify-between border-b border-ink-600 pb-2 last:border-b-0 last:pb-0"
                        key={o.outcomeType}
                      >
                        <span className="font-mono text-sm text-paper-100">{o.outcomeType}</span>
                        <span className="tabular font-mono text-xs text-paper-300">
                          {o.runCount} runs · {formatCost(o.totalCost)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              </section>
            )}

            <section>
              <SectionHeader
                hint="grouped by node"
                number={sectionNumber('detail')}
                title="Per-step detail"
              />
              <Card>
                <p className="mb-4 text-xs text-paper-400">
                  All node executions in this window, grouped by node ID. Skipped + pending
                  excluded.
                </p>
                {stats.perStepFailureRates.length === 0 ? (
                  <EmptyState className="py-6" title="No step executions recorded." />
                ) : (
                  <Table>
                    <THead>
                      <Th variant="compact">Node</Th>
                      <Th align="right" variant="compact">
                        Failed
                      </Th>
                      <Th align="right" variant="compact">
                        Total
                      </Th>
                      <Th align="right" variant="compact">
                        Failure rate
                      </Th>
                    </THead>
                    <tbody>
                      {stats.perStepFailureRates.map((row) => (
                        <TRow key={row.nodeId}>
                          <Td className="py-2 font-mono text-xs text-paper-200">{row.nodeId}</Td>
                          <Td
                            align="right"
                            className="tabular py-2 font-mono text-xs text-paper-300"
                          >
                            {row.failed}
                          </Td>
                          <Td
                            align="right"
                            className="tabular py-2 font-mono text-xs text-paper-300"
                          >
                            {row.total}
                          </Td>
                          <Td
                            align="right"
                            className={cn(
                              'tabular py-2 font-mono text-xs',
                              row.failureRate > 0.25
                                ? 'text-brick-400'
                                : row.failureRate > 0.05
                                  ? 'text-amber-400'
                                  : 'text-paper-500'
                            )}
                          >
                            {formatPercent(row.failureRate)}
                          </Td>
                        </TRow>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>
            </section>
          </>
        )}
      </QueryBoundary>
    </div>
  );
}

function VersionComparison({
  active = false,
  experiment = false,
  n,
  rate,
  version,
}: {
  active?: boolean;
  experiment?: boolean;
  n: number;
  rate: number;
  version: number;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xs text-paper-100">v{version}</span>
        <VersionTags active={active} experiment={experiment} />
      </div>
      <div className="tabular mt-2 font-display text-3xl font-light text-paper-100">
        {formatPercent(rate)}
      </div>
      <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-paper-500">
        {n} runs
      </div>
    </div>
  );
}
