'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Alert } from '@/components/ui/Alert';
import { Card } from '@/components/ui/Card';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Stat } from '@/components/ui/Stat';
import { TabBar } from '@/components/ui/TabBar';
import { useWorkflowTemplate, useWorkflowTemplateAnalytics } from '@/hooks/useTemplates';
import { validateRouteParam } from '@/lib/routeParams';
import { cn, formatCost, formatDuration, formatPercent } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

type SubTab = 'editor' | 'analytics' | 'runs' | 'compare';

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: 'editor', label: 'Editor' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'runs', label: 'Run history' },
  { id: 'compare', label: 'Compare versions' },
];

const WINDOWS = [7, 14, 30, 90] as const;

export default function TemplateAnalyticsPage({ params }: PageProps) {
  const router = useRouter();
  const { id: rawId } = use(params);
  const id = validateRouteParam(rawId);
  const [windowDays, setWindowDays] = useState<number>(30);
  const { data: template } = useWorkflowTemplate(id ?? '');
  const {
    data: stats,
    error,
    isError,
    isLoading,
  } = useWorkflowTemplateAnalytics(id ?? '', windowDays);

  const handleTabChange = (tab: SubTab) => {
    if (tab === 'editor') {
      router.push(`/workflows/library/${id}`);
    } else if (tab === 'runs') {
      router.push(`/workflows/library/${id}/runs`);
    } else if (tab === 'compare') {
      router.push(`/workflows/library/${id}/diff`);
    }
  };

  if (!id) {
    return (
      <div className="p-8">
        <Alert>Template not found</Alert>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <div className="fade-up">
        <Link
          className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500 transition-colors hover:text-ember-400"
          href={`/workflows/library/${id}`}
        >
          <span>←</span> {template?.name ?? 'template'}
        </Link>
        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <PageHeader
            chapter={`§ Analytics · last ${windowDays} days`}
            subtitle="Observed performance and cost metrics for this template across the chosen rolling window."
            title="Observed performance."
          />
          <div className="flex items-end gap-2">
            <label
              className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
              htmlFor="window"
            >
              Window
            </label>
            <Select
              className="h-9 w-auto px-2 font-mono text-xs"
              id="window"
              onChange={(e) => setWindowDays(Number(e.target.value))}
              value={windowDays}
            >
              {WINDOWS.map((w) => (
                <option key={w} value={w}>
                  {w}d
                </option>
              ))}
            </Select>
          </div>
        </div>
      </div>

      <TabBar active="analytics" className="fade-up" onChange={handleTabChange} tabs={SUB_TABS} />

      {isError ? (
        <Alert>
          Unable to load analytics: {error instanceof Error ? error.message : 'request failed'}
        </Alert>
      ) : isLoading || !stats ? (
        <div className="flex items-center justify-center py-20 font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500">
          <span className="pulse-dot mr-3 inline-block h-1.5 w-1.5 rounded-full bg-ember-400" />
          loading analytics…
        </div>
      ) : (
        <>
          {stats.isTruncated && (
            <Alert>
              Analytics are limited to the most recent 10,000 runs or steps in this window.
            </Alert>
          )}
          <section className="fade-up stagger-1 grid grid-cols-2 gap-y-8 border-y border-ink-600 py-8 sm:grid-cols-4">
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
                  : `${Math.round(stats.estimatedHumanTimeSavedTotal)} min`
              }
            />
            <Stat label="Autonomy rate" value={formatPercent(stats.autonomyRate)} />
            <Stat label="Human review rate" value={formatPercent(stats.humanReviewRate)} />
          </section>

          {/* Per-step failure rate chart */}
          {stats.perStepFailureRates.length > 0 && (
            <section className="fade-up stagger-2">
              <SectionHeader hint="sorted by failure rate" number="01" title="Step failure rates" />
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
                        failureRate: Math.round(r.failureRate * 1000) / 10,
                        name: r.nodeId,
                        total: r.total,
                      }))}
                    layout="vertical"
                    margin={{ bottom: 0, left: 0, right: 40, top: 0 }}
                  >
                    <CartesianGrid horizontal={false} stroke="#1f2530" strokeDasharray="3 3" />
                    <XAxis
                      domain={[0, 100]}
                      tick={{ fill: '#7a7162', fontFamily: 'monospace', fontSize: 10 }}
                      tickFormatter={(v) => `${v}%`}
                      type="number"
                    />
                    <YAxis
                      dataKey="name"
                      tick={{ fill: '#a8a395', fontFamily: 'monospace', fontSize: 11 }}
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
                              {d.failureRate}% failure · {d.total} runs
                            </div>
                          </div>
                        );
                      }}
                      cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                    />
                    <Bar dataKey="failureRate" fill="#c44a4a" radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Card>
            </section>
          )}

          {stats.significanceHint && (
            <section className="fade-up stagger-3">
              <SectionHeader hint="two-proportion z-test" number="02" title="A/B significance" />
              <Card>
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-xs text-paper-400">
                    Success-rate comparison between the two most-trafficked versions. Treat this as
                    a hint, not a verdict — apply your own judgement before promoting.
                  </p>
                  <span
                    className={cn(
                      'rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider',
                      stats.significanceHint.isSignificant
                        ? 'border-moss-400/40 bg-moss-400/10 text-moss-400'
                        : 'border-amber-400/40 bg-amber-400/10 text-amber-400'
                    )}
                  >
                    {stats.significanceHint.isSignificant
                      ? `Winner detected · p=${typeof stats.significanceHint.pValue === 'number' ? stats.significanceHint.pValue.toFixed(3) : '—'}`
                      : `Not yet significant · p=${typeof stats.significanceHint.pValue === 'number' ? stats.significanceHint.pValue.toFixed(3) : '—'}`}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-8 gap-y-4 border-t border-ink-600 pt-4">
                  <VersionComparison
                    badge={
                      stats.significanceHint.versionA === template?.activeVersion
                        ? { label: 'active', tone: 'moss' }
                        : null
                    }
                    n={stats.significanceHint.nA}
                    rate={stats.significanceHint.successRateA}
                    version={stats.significanceHint.versionA}
                  />
                  <VersionComparison
                    badge={
                      stats.significanceHint.versionB === template?.experimentVersion
                        ? { label: 'experiment', tone: 'violet' }
                        : null
                    }
                    n={stats.significanceHint.nB}
                    rate={stats.significanceHint.successRateB}
                    version={stats.significanceHint.versionB}
                  />
                </div>
              </Card>
            </section>
          )}

          {stats.perVersionCounts.length > 1 && (
            <section className="fade-up stagger-4">
              <SectionHeader
                hint="traffic split"
                number={stats.significanceHint ? '03' : '02'}
                title="Per-version run mix"
              />
              <Card>
                <p className="mb-4 text-xs text-paper-400">
                  Useful for confirming the A/B traffic split is landing where you configured it.
                </p>
                <ul className="space-y-2">
                  {stats.perVersionCounts.map((v) => {
                    const pct = stats.totalRuns > 0 ? (v.count / stats.totalRuns) * 100 : 0;
                    return (
                      <li
                        className="flex items-center justify-between border-b border-ink-600 pb-2 last:border-b-0 last:pb-0"
                        key={v.version}
                      >
                        <span className="flex items-baseline gap-2 font-mono text-sm">
                          <span className="text-paper-100">v{v.version}</span>
                          {v.version === template?.activeVersion && (
                            <span className="rounded border border-moss-400/40 bg-moss-400/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-moss-400">
                              active
                            </span>
                          )}
                          {v.version === template?.experimentVersion && (
                            <span className="rounded border border-violet-400/40 bg-violet-400/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-violet-400">
                              experiment
                            </span>
                          )}
                        </span>
                        <span className="tabular font-mono text-xs text-paper-300">
                          {v.count}
                          <span className="ml-2 text-paper-500">({pct.toFixed(0)}%)</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </section>
          )}

          {stats.perOutcome.length > 0 && (
            <section className="fade-up stagger-4">
              <SectionHeader
                hint="cost by outcome"
                number={
                  stats.significanceHint
                    ? stats.perVersionCounts.length > 1
                      ? '04'
                      : '03'
                    : stats.perVersionCounts.length > 1
                      ? '03'
                      : '02'
                }
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

          <section className="fade-up stagger-5">
            <SectionHeader
              hint="grouped by node"
              number={
                stats.significanceHint ? '04' : stats.perVersionCounts.length > 1 ? '03' : '02'
              }
              title="Per-step detail"
            />
            <Card>
              <p className="mb-4 text-xs text-paper-400">
                All node executions in this window, grouped by node ID. Skipped + pending excluded.
              </p>
              {stats.perStepFailureRates.length === 0 ? (
                <div className="py-6 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500">
                  no step executions recorded
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-ink-600">
                      <Th>Node</Th>
                      <Th align="right">Failed</Th>
                      <Th align="right">Total</Th>
                      <Th align="right">Failure rate</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.perStepFailureRates.map((row) => (
                      <tr className="border-b border-ink-600 last:border-b-0" key={row.nodeId}>
                        <td className="py-2 font-mono text-xs text-paper-200">{row.nodeId}</td>
                        <td className="tabular py-2 text-right font-mono text-xs text-paper-300">
                          {row.failed}
                        </td>
                        <td className="tabular py-2 text-right font-mono text-xs text-paper-300">
                          {row.total}
                        </td>
                        <td
                          className={cn(
                            'tabular py-2 text-right font-mono text-xs',
                            row.failureRate > 0.25
                              ? 'text-brick-400'
                              : row.failureRate > 0.05
                                ? 'text-amber-400'
                                : 'text-paper-500'
                          )}
                        >
                          {formatPercent(row.failureRate)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </section>
        </>
      )}
    </div>
  );
}

function VersionComparison({
  version,
  rate,
  n,
  badge,
}: {
  version: number;
  rate: number;
  n: number;
  badge: { label: string; tone: 'moss' | 'violet' } | null;
}) {
  const badgeClass =
    badge?.tone === 'moss'
      ? 'border-moss-400/40 bg-moss-400/10 text-moss-400'
      : 'border-violet-400/40 bg-violet-400/10 text-violet-400';
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xs text-paper-100">v{version}</span>
        {badge && (
          <span
            className={cn(
              'rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider',
              badgeClass
            )}
          >
            {badge.label}
          </span>
        )}
      </div>
      <div className="tabular mt-2 font-display text-3xl font-light text-paper-100">
        {(rate * 100).toFixed(1)}
        <span className="ml-1 font-mono text-[11px] uppercase tracking-wider text-paper-500">
          %
        </span>
      </div>
      <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-paper-500">
        {n} runs
      </div>
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={cn(
        'py-2 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-paper-500',
        align === 'right' ? 'text-right' : 'text-left'
      )}
    >
      {children}
    </th>
  );
}
