'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useWorkflowTemplate, useWorkflowTemplateAnalytics } from '@/hooks/useWorkflows';
import { formatCost, formatDuration, formatPercent } from '@/lib/utils';

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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link className="text-[var(--primary)] hover:underline text-sm" href={`/templates/${id}`}>
            &larr; {template?.name ?? 'Template'}
          </Link>
          <h2 className="text-2xl font-bold">Analytics</h2>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-[var(--muted-foreground)]">Window</span>
          <select
            className="px-2 py-1 border border-[var(--border)] rounded text-sm bg-[var(--background)]"
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
      </div>

      {isLoading || !stats ? (
        <div className="text-center py-12 text-[var(--muted-foreground)]">Loading…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KpiCard label="Total runs" value={String(stats.totalRuns)} />
            <KpiCard label="Success rate" value={formatPercent(stats.successRate)} />
            <KpiCard label="p50 duration" value={formatDuration(stats.p50DurationMs)} />
            <KpiCard label="p95 duration" value={formatDuration(stats.p95DurationMs)} />
            <KpiCard label="Avg cost / run" value={formatUsdNullable(stats.avgCostPerRun)} />
            <KpiCard label="Total cost" value={formatUsdNullable(stats.totalCost)} />
            <KpiCard label="Succeeded" value={String(stats.succeeded)} />
            <KpiCard label="Failed" value={String(stats.failed)} />
          </div>

          {stats.significanceHint && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>A/B significance</CardTitle>
                  {stats.significanceHint.isSignificant ? (
                    <span className="text-xs px-2 py-1 bg-green-100 text-green-800 rounded-full font-medium">
                      Winner detected (p={stats.significanceHint.pValue.toFixed(3)})
                    </span>
                  ) : (
                    <span className="text-xs px-2 py-1 bg-amber-100 text-amber-800 rounded-full font-medium">
                      Not yet significant (p={stats.significanceHint.pValue.toFixed(3)})
                    </span>
                  )}
                </div>
              </CardHeader>
              <p className="text-xs text-[var(--muted-foreground)] mb-3">
                Two-proportion z-test on success rate between the two most-trafficked versions. This
                is a hint, not a verdict — apply your own judgement before promoting.
              </p>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="space-y-1">
                  <p className="font-mono text-xs text-[var(--muted-foreground)]">
                    v{stats.significanceHint.versionA}
                    {stats.significanceHint.versionA === template?.activeVersion && (
                      <span className="ml-1 px-1 py-0.5 bg-green-100 text-green-800 rounded">
                        active
                      </span>
                    )}
                  </p>
                  <p className="text-xl font-bold">
                    {(stats.significanceHint.successRateA * 100).toFixed(1)}%
                  </p>
                  <p className="text-xs text-[var(--muted-foreground)]">
                    {stats.significanceHint.nA} runs
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="font-mono text-xs text-[var(--muted-foreground)]">
                    v{stats.significanceHint.versionB}
                    {stats.significanceHint.versionB === template?.experimentVersion && (
                      <span className="ml-1 px-1 py-0.5 bg-purple-100 text-purple-800 rounded">
                        experiment
                      </span>
                    )}
                  </p>
                  <p className="text-xl font-bold">
                    {(stats.significanceHint.successRateB * 100).toFixed(1)}%
                  </p>
                  <p className="text-xs text-[var(--muted-foreground)]">
                    {stats.significanceHint.nB} runs
                  </p>
                </div>
              </div>
            </Card>
          )}

          {stats.perVersionCounts.length > 1 && (
            <Card>
              <CardHeader>
                <CardTitle>Per-version run mix</CardTitle>
              </CardHeader>
              <p className="text-xs text-[var(--muted-foreground)] mb-3">
                Useful for confirming the A/B traffic split is landing where you configured it.
              </p>
              <ul className="space-y-1 text-sm">
                {stats.perVersionCounts.map((v) => {
                  const pct = stats.totalRuns > 0 ? (v.count / stats.totalRuns) * 100 : 0;
                  return (
                    <li className="flex items-center justify-between" key={v.version}>
                      <span className="font-mono">
                        v{v.version}
                        {v.version === template?.activeVersion && (
                          <span className="ml-2 text-xs px-1 py-0.5 bg-green-100 text-green-800 rounded">
                            active
                          </span>
                        )}
                        {v.version === template?.experimentVersion && (
                          <span className="ml-2 text-xs px-1 py-0.5 bg-purple-100 text-purple-800 rounded">
                            experiment
                          </span>
                        )}
                      </span>
                      <span className="font-mono text-xs">
                        {v.count} ({pct.toFixed(0)}%)
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Per-step failure rate</CardTitle>
            </CardHeader>
            <p className="text-xs text-[var(--muted-foreground)] mb-3">
              All node executions in this window, grouped by node ID. Skipped + pending excluded.
              Sorted by failure rate desc.
            </p>
            {stats.perStepFailureRates.length === 0 ? (
              <div className="text-sm text-[var(--muted-foreground)]">
                No step executions recorded.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)]">
                    <th className="text-left py-2 font-medium">Node</th>
                    <th className="text-right py-2 font-medium">Failed</th>
                    <th className="text-right py-2 font-medium">Total</th>
                    <th className="text-right py-2 font-medium">Failure rate</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.perStepFailureRates.map((row) => (
                    <tr className="border-b border-[var(--border)]" key={row.nodeId}>
                      <td className="py-2 font-mono text-xs">{row.nodeId}</td>
                      <td className="py-2 text-right font-mono text-xs">{row.failed}</td>
                      <td className="py-2 text-right font-mono text-xs">{row.total}</td>
                      <td className="py-2 text-right font-mono text-xs">
                        <span
                          className={
                            row.failureRate > 0.25
                              ? 'text-red-700'
                              : row.failureRate > 0.05
                                ? 'text-amber-700'
                                : 'text-[var(--muted-foreground)]'
                          }
                        >
                          {formatPercent(row.failureRate)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <div className="text-xs text-[var(--muted-foreground)]">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </Card>
  );
}
