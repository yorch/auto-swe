'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { ScorerBreakdownChart } from '@/components/charts/ScorerBreakdownChart';
import { ScorerTrendChart } from '@/components/charts/ScorerTrendChart';
import { SuiteHealthChart } from '@/components/charts/SuiteHealthChart';
import { EvalResultsTable } from '@/components/evals/EvalResultsTable';
import { EvalRunStatusBadge } from '@/components/evals/EvalRunStatusBadge';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { DateRangeControl } from '@/components/ui/DateRangeControl';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  useEvalDatasets,
  useEvalSuiteHealth,
  useEvalTrends,
  useLatestEvalRuns,
} from '@/hooks/useAdmin';
import { useWorkflowTemplates } from '@/hooks/useTemplates';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { customRangeIgnored, dateRangePatch, describeRange, parseDateRange } from '@/lib/dateRange';
import { latestMean, scorerChange, worstMovingScorer } from '@/lib/evalTrend';
import { cn, formatDate, scoreColor } from '@/lib/utils';

const BREAKDOWN_OPTIONS = [
  { label: 'Scorer', value: '' },
  { label: 'Judge model', value: 'judgeModel' },
  { label: 'Agent', value: 'agentKey' },
];

type Breakdown = '' | 'judgeModel' | 'agentKey';

/** Movement across the window, with an arrow; higher scores are better, so up is green. */
function ChangeCell({ value }: { value: number | null }) {
  if (value === null || Math.abs(value) < 0.005) {
    return <span className="text-paper-600">{value === null ? '—' : '→ 0.00'}</span>;
  }
  const up = value > 0;
  return (
    <span
      className={cn('num font-mono text-xs', up ? 'text-moss-400' : 'text-brick-400')}
      title="Latest day's mean minus the first day's mean in this window"
    >
      {up ? '▲' : '▼'} {up ? '+' : '−'}
      {Math.abs(value).toFixed(2)}
    </span>
  );
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

function EvalsWorkspace() {
  const { params, update } = useUrlFilters();
  const range = parseDateRange(params);
  const rawBy = params.get('by');
  const by: Breakdown = rawBy === 'judgeModel' || rawBy === 'agentKey' ? rawBy : '';
  const templateId = params.get('template') ?? '';
  // The scorer the chart shows. The results table below filters on its own, so
  // looking at one scorer's trend never empties the list of every other result.
  const chosenScorer = params.get('scorer') ?? '';
  const [resultScorer, setResultScorer] = useState('');
  const trendsQuery = useEvalTrends(range, {
    by: by || undefined,
    templateId: templateId || undefined,
  });
  const templates = useWorkflowTemplates();
  const healthQuery = useEvalSuiteHealth();
  const datasetsQuery = useEvalDatasets();
  const latestRuns = useLatestEvalRuns(5);
  const trends = trendsQuery.data?.scorers ?? [];
  const weekly = trendsQuery.data?.bucketDays === 7;
  const scorerNames = [...new Set(trends.map((t) => t.scorer))];
  const datasets = datasetsQuery.data;
  // Until one is picked (or when the pick has no signal in this window), the scorer
  // that fell furthest — the one most worth a look.
  const scorer = scorerNames.includes(chosenScorer)
    ? chosenScorer
    : (worstMovingScorer(trends) ?? '');
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
              onChange={(v) => update({ template: v || null })}
              options={templateOptions}
              value={templateId}
            />
            <SegmentedControl
              ariaLabel="Break trends down by"
              onChange={(v) => update({ by: v || null })}
              options={BREAKDOWN_OPTIONS}
              value={by}
            />
            <DateRangeControl
              onChange={(r) => r && update(dateRangePatch(r))}
              rangeIgnored={customRangeIgnored(params)}
              value={range}
            />
          </div>
        }
        chapter="§ Govern"
        subtitle="Per-scorer quality signals over time, every captured result with a link to the run it scored, and the datasets offline runs score against. Days are UTC."
        title="Evals"
      />

      <Card>
        <CardHeader>
          <CardTitle eyebrow="Latest benchmark runs">Latest eval runs</CardTitle>
        </CardHeader>
        <QueryBoundary
          error={latestRuns.error}
          isError={latestRuns.isError}
          isFetching={latestRuns.isFetching}
          isLoading={latestRuns.isLoading}
          label="eval runs"
          onRetry={() => void latestRuns.refetch()}
        >
          {latestRuns.data && latestRuns.data.length > 0 ? (
            <div className="space-y-1">
              {latestRuns.data.map((r) => (
                <div
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-ink-600 py-1.5 last:border-0"
                  key={r.id}
                >
                  <Link
                    className="text-sm text-paper-200 hover:text-ember-400 hover:underline"
                    href={`/govern/evals/runs/${r.id}`}
                  >
                    {r.datasetName ?? r.datasetSlug ?? 'Benchmark'}
                    <span className="ml-2 font-mono text-xs text-paper-500">
                      {r.candidateRef} vs {r.baselineRef}
                    </span>
                  </Link>
                  <span className="flex items-center gap-3">
                    <span className="text-xs text-paper-500">{formatDate(r.startedAt)}</span>
                    <EvalRunStatusBadge partial={r.partial} status={r.status} />
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              hint={
                <>
                  Start one with{' '}
                  <code>
                    auto-swe evals run &lt;dataset&gt; --candidate=&lt;ref&gt; --against=&lt;ref&gt;
                  </code>
                  .
                </>
              }
              title="No benchmark runs yet."
            />
          )}
        </QueryBoundary>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle
            eyebrow={`${weekly ? 'Weekly' : 'Daily'} mean · ${describeRange(range).toLowerCase()}`}
          >
            {scorer || 'Scorer trends'}
          </CardTitle>
        </CardHeader>
        <QueryBoundary
          error={trendsQuery.error}
          isError={trendsQuery.isError}
          isFetching={trendsQuery.isFetching}
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
                  title={`${scorer || 'Scorer'} by ${by === 'judgeModel' ? 'judge model' : 'agent'}, ${weekly ? 'weekly' : 'daily'} mean`}
                />
              ) : charted.length === 1 && charted[0] ? (
                <ScorerTrendChart
                  data={charted[0].daily}
                  title={`${scorer || 'Scorer'} ${weekly ? 'weekly' : 'daily'} mean`}
                />
              ) : (
                <EmptyState title={`No ${scorer} signals in this window.`} />
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
                  <Th align="right" variant="dense">
                    Change
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
                          onClick={() => update({ scorer: t.scorer })}
                          title="Chart this scorer"
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
                      <Td align="right" className="px-4 py-2">
                        <ChangeCell value={scorerChange(t)} />
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
          isFetching={healthQuery.isFetching}
          isLoading={healthQuery.isLoading}
          label="suite health"
          onRetry={() => void healthQuery.refetch()}
        >
          {healthQuery.data && (
            <SuiteHealthChart
              datasets={healthQuery.data.datasets}
              maxStaleRate={healthQuery.data.thresholds.maxStaleRate}
              title="Share of golden cases quarantined as stale, by dataset"
            />
          )}
        </QueryBoundary>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Results</CardTitle>
        </CardHeader>
        <EvalResultsTable
          onScorerChange={setResultScorer}
          scorer={resultScorer}
          scorers={scorerNames}
        />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Datasets ({datasets?.length ?? 0})</CardTitle>
        </CardHeader>
        <QueryBoundary
          error={datasetsQuery.error}
          isError={datasetsQuery.isError}
          isFetching={datasetsQuery.isFetching}
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
            <EmptyState
              hint="Datasets are created through the platform API; list and run them with auto-swe evals list and auto-swe evals run."
              title="No datasets."
            />
          )}
        </QueryBoundary>
      </Card>
    </div>
  );
}

export default function GovernEvalsPage() {
  return (
    <Suspense fallback={null}>
      <EvalsWorkspace />
    </Suspense>
  );
}
