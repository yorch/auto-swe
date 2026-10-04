'use client';

import type { EvalScorerTrend } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useState } from 'react';
import { ScorerBreakdownChart } from '@/components/charts/ScorerBreakdownChart';
import { ScorerTrendChart } from '@/components/charts/ScorerTrendChart';
import { SuiteHealthChart } from '@/components/charts/SuiteHealthChart';
import { EvalResultsTable } from '@/components/evals/EvalResultsTable';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useEvalDatasets, useEvalSuiteHealth, useEvalTrends } from '@/hooks/useAdmin';
import { useWorkflowTemplates } from '@/hooks/useTemplates';
import { cn, formatPercent, scoreColor } from '@/lib/utils';

const WINDOW_OPTIONS = [7, 30, 90].map((days) => ({ label: `${days}d`, value: String(days) }));

const BREAKDOWN_OPTIONS = [
  { label: 'Scorer', value: '' },
  { label: 'Judge model', value: 'judgeModel' },
  { label: 'Agent', value: 'agentKey' },
];

type Breakdown = '' | 'judgeModel' | 'agentKey';

/** The mean of the most recent day that had any signal, for the "latest" column. */
function latestMean(trend: EvalScorerTrend): number | null {
  for (let i = trend.daily.length - 1; i >= 0; i--) {
    const day = trend.daily[i];
    if (day && day.mean !== null) {
      return day.mean;
    }
  }
  return null;
}

function ScoreCell({ value }: { value: number | null }) {
  if (value === null) {
    return <span className="text-paper-600">—</span>;
  }
  return (
    <span className="num font-mono text-xs" style={{ color: scoreColor(value) }}>
      {value.toFixed(2)}
    </span>
  );
}

export default function GovernEvalsPage() {
  const [windowDays, setWindowDays] = useState(30);
  // One scorer drives both the trend chart and the results filter: the chart
  // shows only the selected scorer, never a stand-in the results do not match.
  const [scorer, setScorer] = useState('');
  const [by, setBy] = useState<Breakdown>('');
  const [templateId, setTemplateId] = useState('');
  const trendsQuery = useEvalTrends(windowDays, {
    by: by || undefined,
    templateId: templateId || undefined,
  });
  const templates = useWorkflowTemplates();
  const healthQuery = useEvalSuiteHealth();
  const datasetsQuery = useEvalDatasets();
  const trends = trendsQuery.data?.scorers ?? [];
  const scorerNames = [...new Set(trends.map((t) => t.scorer))];
  const datasets = datasetsQuery.data;
  // With a breakdown a scorer has one series per value, and they chart together.
  const charted = scorer ? trends.filter((t) => t.scorer === scorer) : [];
  const templateOptions = [
    { label: 'All templates', value: '' },
    ...(templates.data ?? []).map((t) => ({ label: t.name, value: t.id })),
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <Select
              appearance="pill"
              aria-label="Workflow template"
              onChange={setTemplateId}
              options={templateOptions}
              value={templateId}
            />
            <SegmentedControl
              ariaLabel="Break trends down by"
              onChange={(v) => setBy(v as Breakdown)}
              options={BREAKDOWN_OPTIONS}
              value={by}
            />
            <SegmentedControl
              ariaLabel="Trend window"
              onChange={(v) => setWindowDays(Number(v))}
              options={WINDOW_OPTIONS}
              value={String(windowDays)}
            />
          </div>
        }
        chapter="§ Govern"
        subtitle="Per-scorer quality signals over time, every captured result with a link to the run it scored, and the datasets offline runs score against. Days are UTC."
        title="Evals"
      />

      <Card>
        <CardHeader>
          <CardTitle eyebrow={`Daily mean · last ${windowDays} days`}>
            {scorer || 'Scorer trends'}
          </CardTitle>
        </CardHeader>
        <QueryBoundary
          error={trendsQuery.error}
          isError={trendsQuery.isError}
          isLoading={trendsQuery.isLoading}
          label="eval trends"
          onRetry={() => void trendsQuery.refetch()}
        >
          {trends.length === 0 ? (
            <EmptyState title="No eval signals in this window." />
          ) : (
            <div className="space-y-6">
              {charted.length > 1 ? (
                <ScorerBreakdownChart
                  series={charted.map((t) => ({
                    daily: t.daily,
                    label: t.breakdown ?? '(none)',
                  }))}
                />
              ) : charted.length === 1 && charted[0] ? (
                <ScorerTrendChart data={charted[0].daily} />
              ) : scorer ? (
                <EmptyState title={`No ${scorer} signals in this window.`} />
              ) : (
                <EmptyState title="Pick a scorer to chart its daily mean and filter the results." />
              )}
              <Table>
                <THead>
                  <Th variant="dense">Scorer</Th>
                  {by && <Th variant="dense">{by === 'judgeModel' ? 'Judge model' : 'Agent'}</Th>}
                  <Th align="right" variant="dense">
                    Signals
                  </Th>
                  <Th align="right" variant="dense">
                    Window mean
                  </Th>
                  <Th align="right" variant="dense">
                    Latest day
                  </Th>
                </THead>
                <tbody>
                  {trends.map((t) => (
                    <TRow hover key={`${t.scorer}\u0000${t.breakdown ?? ''}`}>
                      <Td className="px-4 py-2">
                        <button
                          aria-pressed={t.scorer === scorer}
                          className={cn(
                            'font-mono text-xs hover:text-ember-400',
                            t.scorer === scorer ? 'text-ember-400' : 'text-paper-300'
                          )}
                          onClick={() => setScorer(t.scorer)}
                          title="Chart this scorer and filter the results to it"
                          type="button"
                        >
                          {t.scorer}
                        </button>
                      </Td>
                      {by && (
                        <Td className="px-4 py-2 font-mono text-xs text-paper-400">
                          {t.breakdown ?? '(none)'}
                        </Td>
                      )}
                      <Td align="right" className="px-4 py-2 font-mono text-xs text-paper-400">
                        {t.n}
                      </Td>
                      <Td align="right" className="px-4 py-2">
                        <ScoreCell value={t.mean} />
                      </Td>
                      <Td align="right" className="px-4 py-2">
                        <ScoreCell value={latestMean(t)} />
                      </Td>
                    </TRow>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </QueryBoundary>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle eyebrow="Share of golden cases quarantined as stale">Suite health</CardTitle>
        </CardHeader>
        <QueryBoundary
          error={healthQuery.error}
          isError={healthQuery.isError}
          isLoading={healthQuery.isLoading}
          label="suite health"
          onRetry={() => void healthQuery.refetch()}
        >
          {healthQuery.data && (
            <div className="space-y-3">
              <SuiteHealthChart
                datasets={healthQuery.data.datasets}
                maxStaleRate={healthQuery.data.thresholds.maxStaleRate}
              />
              <p className="text-xs text-paper-600">
                Flake rate (max {formatPercent(healthQuery.data.thresholds.maxFlakeRate)}) and judge
                kappa (min {healthQuery.data.thresholds.minKappa}) have no stored measurement to
                chart.
              </p>
            </div>
          )}
        </QueryBoundary>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Results</CardTitle>
        </CardHeader>
        <EvalResultsTable onScorerChange={setScorer} scorer={scorer} scorers={scorerNames} />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Datasets ({datasets?.length ?? 0})</CardTitle>
        </CardHeader>
        <QueryBoundary
          error={datasetsQuery.error}
          isError={datasetsQuery.isError}
          isLoading={datasetsQuery.isLoading}
          label="eval datasets"
          onRetry={() => void datasetsQuery.refetch()}
        >
          {datasets && datasets.length > 0 ? (
            <div className="space-y-1">
              {datasets.map((d) => (
                <div
                  className="flex items-center justify-between gap-3 border-b border-ink-600 py-1.5 last:border-0"
                  key={d.id}
                >
                  <Link
                    className="font-mono text-xs text-paper-300 hover:text-ember-400 hover:underline"
                    href={`/govern/evals/datasets/${d.id}`}
                  >
                    {d.slug} <span className="text-paper-600">[{d.scope}]</span>
                  </Link>
                  <span className="text-xs text-paper-600">{d.caseCount} cases</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState hint="Create one via the admin API or CLI." title="No datasets." />
          )}
        </QueryBoundary>
      </Card>
    </div>
  );
}
