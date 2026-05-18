'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { Stat } from '@/components/ui/Stat';
import { useWorkflowTemplate, useWorkflowTemplateAnalytics } from '@/hooks/useWorkflows';
import { cn, formatCost, formatDuration, formatPercent } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

const WINDOWS = [7, 14, 30, 90] as const;

const formatUsdNullable = (n: number | null) => (n === null ? '—' : formatCost(n));

export default function TemplateAnalyticsPage({ params }: PageProps) {
  const { id } = use(params);
  const [windowDays, setWindowDays] = useState<number>(30);
  const { data: template } = useWorkflowTemplate(id);
  const { data: stats, isLoading } = useWorkflowTemplateAnalytics(id, windowDays);

  return (
    <div className="space-y-10">
      <div className="fade-up">
        <Link
          className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500 transition-colors hover:text-ember-400"
          href={`/templates/${id}`}
        >
          <span>←</span> {template?.name ?? 'template'}
        </Link>
        <div className="mt-4">
          <PageHeader
            actions={
              <div className="flex items-end gap-2">
                <label
                  className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
                  htmlFor="window"
                >
                  Window
                </label>
                <select
                  className="h-9 rounded-sm border border-ink-500 bg-ink-900/60 px-2 font-mono text-xs text-paper-100 outline-none focus:border-ember-400"
                  id="window"
                  onChange={(e) => setWindowDays(Number(e.target.value))}
                  value={windowDays}
                >
                  {WINDOWS.map((w) => (
                    <option key={w} value={w}>
                      {w}d
                    </option>
                  ))}
                </select>
              </div>
            }
            chapter={`§ Analytics · last ${windowDays} days`}
            subtitle="Observed performance and cost metrics for this template across the chosen rolling window."
            title="Observed performance."
          />
        </div>
      </div>

      {isLoading || !stats ? (
        <div className="flex items-center justify-center py-20 font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500">
          <span className="pulse-dot mr-3 inline-block h-1.5 w-1.5 rounded-full bg-ember-400" />
          loading analytics…
        </div>
      ) : (
        <>
          <section className="fade-up stagger-1 grid grid-cols-2 gap-y-8 border-y border-ink-600 py-8 sm:grid-cols-4">
            <Stat label="Total runs" tone="ember" unit="runs" value={stats.totalRuns} />
            <Stat label="Success rate" tone="moss" value={formatPercent(stats.successRate)} />
            <Stat label="p50 duration" value={formatDuration(stats.p50DurationMs)} />
            <Stat label="p95 duration" value={formatDuration(stats.p95DurationMs)} />
            <Stat
              label="Avg cost / run"
              tone="amber"
              value={formatUsdNullable(stats.avgCostPerRun)}
            />
            <Stat label="Total cost" value={formatUsdNullable(stats.totalCost)} />
            <Stat label="Succeeded" tone="moss" value={stats.succeeded} />
            <Stat label="Failed" tone="brick" value={stats.failed} />
          </section>

          {stats.significanceHint && (
            <section className="fade-up stagger-2">
              <SectionHeader hint="two-proportion z-test" number="01" title="A/B significance" />
              <Card>
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-xs text-paper-400">
                    Success-rate comparison between the two most-trafficked versions. Treat this as
                    a hint, not a verdict — apply your own judgement before promoting.
                  </p>
                  <span
                    className={cn(
                      'rounded-sm border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider',
                      stats.significanceHint.isSignificant
                        ? 'border-moss-400/40 bg-moss-400/10 text-moss-400'
                        : 'border-amber-400/40 bg-amber-400/10 text-amber-400'
                    )}
                  >
                    {stats.significanceHint.isSignificant
                      ? `Winner detected · p=${stats.significanceHint.pValue.toFixed(3)}`
                      : `Not yet significant · p=${stats.significanceHint.pValue.toFixed(3)}`}
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
            <section className="fade-up stagger-3">
              <SectionHeader hint="traffic split" number="02" title="Per-version run mix" />
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
                            <span className="rounded-sm border border-moss-400/40 bg-moss-400/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-moss-400">
                              active
                            </span>
                          )}
                          {v.version === template?.experimentVersion && (
                            <span className="rounded-sm border border-violet-400/40 bg-violet-400/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-violet-400">
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

          <section className="fade-up stagger-4">
            <SectionHeader
              hint="grouped by node · sorted by failure rate"
              number={stats.significanceHint ? '03' : '01'}
              title="Per-step failure rate"
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
              'rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider',
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
