'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { ScorerBreakdownChart } from '@/components/charts/ScorerBreakdownChart';
import { ScorerTrendChart } from '@/components/charts/ScorerTrendChart';
import { SuiteHealthChart } from '@/components/charts/SuiteHealthChart';
import { EvalResultsTable } from '@/components/evals/EvalResultsTable';
import { EvalRunStatusBadge } from '@/components/evals/EvalRunStatusBadge';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { DateRangeControl } from '@/components/ui/DateRangeControl';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { Toolbar } from '@/components/ui/Toolbar';
import {
  useEvalDatasets,
  useEvalSuiteHealth,
  useEvalTrends,
  useLatestEvalRuns,
} from '@/hooks/useAdmin';
import { useWorkflowTemplates } from '@/hooks/useTemplates';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { customRangeIgnored, dateRangePatch, describeRange, parseDateRange } from '@/lib/dateRange';
import { formatArm } from '@/lib/evalRuntime';
import { latestMean, scorerChange, worstMovingScorer } from '@/lib/evalTrend';
import { cn, FOCUS_RING, formatDate, formatRelativeTime, scoreColor } from '@/lib/utils';

const BREAKDOWN_OPTIONS = [
  { label: 'Scorer', value: '' },
  { label: 'Judge model', value: 'judgeModel' },
  { label: 'Agent', value: 'agentKey' },
  { label: 'Runtime', value: 'runtime' },
];

type Breakdown = '' | 'judgeModel' | 'agentKey' | 'runtime';

/** What a breakdown splits by, as a noun for titles and the column header. */
const BREAKDOWN_NOUN: Record<Exclude<Breakdown, ''>, string> = {
  agentKey: 'agent',
  judgeModel: 'judge model',
  runtime: 'implementer runtime',
};
const BREAKDOWN_HEADER: Record<Exclude<Breakdown, ''>, string> = {
  agentKey: 'Agent',
  judgeModel: 'Judge model',
  runtime: 'Runtime',
};

/** Movement across the window, with an arrow; higher scores are better, so up is green. */
function ChangeCell({ value }: { value: number | null }) {
  if (value === null || Math.abs(value) < 0.005) {
    return (
      <span className="text-[13px] text-paper-500 tabular-nums">
        {value === null ? '—' : '→ 0.00'}
      </span>
    );
  }
  const up = value > 0;
  return (
    <span
      className={cn('text-[13px] tabular-nums', up ? 'text-moss-400' : 'text-brick-400')}
      title="Latest day's mean minus the first day's mean in this window"
    >
      {up ? '▲' : '▼'} {up ? '+' : '−'}
      {Math.abs(value).toFixed(2)}
    </span>
  );
}

function ScoreCell({ value }: { value: number | null }) {
  if (value === null) {
    return <span className="text-paper-500">—</span>;
  }
  return (
    <span className="text-[13px] font-medium tabular-nums" style={{ color: scoreColor(value) }}>
      {value.toFixed(2)}
    </span>
  );
}

function EvalsWorkspace() {
  const { params, update } = useUrlFilters();
  const range = parseDateRange(params);
  const rawBy = params.get('by');
  const by: Breakdown =
    rawBy === 'judgeModel' || rawBy === 'agentKey' || rawBy === 'runtime' ? rawBy : '';
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

  const trendCard = (
    <Card>
      <CardHeader>
        <CardTitle
          eyebrow={`${weekly ? 'Weekly' : 'Daily'} mean · ${describeRange(range).toLowerCase()}`}
        >
          {scorer ? <span className="font-mono">{scorer}</span> : 'Scorer trends'}
        </CardTitle>
        <span className="text-xs text-paper-500">Score 0–1, higher is better</span>
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
          <EmptyState
            bordered
            hint="Scorers grade runs as they finish. Try a longer range, or another template."
            icon="analytics"
            title="No eval signals in this window"
          />
        ) : (
          <div className="space-y-6">
            {charted.length > 1 ? (
              <ScorerBreakdownChart
                granularity={weekly ? 'week' : 'day'}
                series={charted.map((t) => ({
                  daily: t.daily,
                  label: t.breakdown ?? '(none)',
                }))}
                title={`${scorer || 'Scorer'} by ${by ? BREAKDOWN_NOUN[by] : 'agent'}, ${weekly ? 'weekly' : 'daily'} mean`}
              />
            ) : charted.length === 1 && charted[0] ? (
              <ScorerTrendChart
                data={charted[0].daily}
                granularity={weekly ? 'week' : 'day'}
                title={`${scorer || 'Scorer'} ${weekly ? 'weekly' : 'daily'} mean`}
              />
            ) : (
              <EmptyState title={`No ${scorer} signals in this window.`} />
            )}
            <div className="-mx-4">
              <p className="mb-2 px-4 text-xs text-paper-500">
                Choose a scorer to chart it. The one that fell furthest is charted until you do.
              </p>
              <Table>
                <THead>
                  <Th variant="plain">Scorer</Th>
                  {by && <Th variant="plain">{BREAKDOWN_HEADER[by]}</Th>}
                  <Th align="right" variant="plain">
                    Signals
                  </Th>
                  <Th align="right" variant="plain">
                    Window mean
                  </Th>
                  <Th align="right" variant="plain">
                    Latest day
                  </Th>
                  <Th align="right" variant="plain">
                    Change
                  </Th>
                </THead>
                <tbody>
                  {trends.map((t) => {
                    const selected = t.scorer === scorer;
                    return (
                      <TRow
                        className={cn(selected && 'bg-ember-400/[0.06]')}
                        hover
                        key={`${t.scorer}\u0000${t.breakdown ?? ''}`}
                      >
                        <Td className="px-4 py-2.5">
                          <button
                            aria-pressed={selected}
                            className={cn(
                              'inline-flex items-center gap-2 rounded-sm font-mono text-[13px] hover:text-ember-300',
                              FOCUS_RING,
                              selected ? 'text-ember-300' : 'text-paper-200'
                            )}
                            onClick={() => update({ scorer: t.scorer })}
                            title="Chart this scorer"
                            type="button"
                          >
                            <span
                              aria-hidden
                              className={cn(
                                'h-1.5 w-1.5 shrink-0 rounded-full',
                                selected ? 'bg-ember-400' : 'bg-ink-400'
                              )}
                            />
                            {t.scorer}
                          </button>
                        </Td>
                        {by && (
                          <Td className="px-4 py-2.5 font-mono text-xs text-paper-400">
                            {t.breakdown ?? '(none)'}
                          </Td>
                        )}
                        <Td
                          align="right"
                          className="px-4 py-2.5 text-[13px] text-paper-400 tabular-nums"
                        >
                          {t.n}
                        </Td>
                        <Td align="right" className="px-4 py-2.5">
                          <ScoreCell value={t.mean} />
                        </Td>
                        <Td align="right" className="px-4 py-2.5">
                          <ScoreCell value={latestMean(t)} />
                        </Td>
                        <Td align="right" className="px-4 py-2.5">
                          <ChangeCell value={scorerChange(t)} />
                        </Td>
                      </TRow>
                    );
                  })}
                </tbody>
              </Table>
            </div>
          </div>
        )}
      </QueryBoundary>
    </Card>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <DateRangeControl
            onChange={(r) => r && update(dateRangePatch(r))}
            rangeIgnored={customRangeIgnored(params)}
            value={range}
          />
        }
        subtitle="Per-scorer quality signals over time, every captured result with a link to the run it scored, and the datasets offline runs score against. Days are UTC."
        title="Evals"
      />

      <Toolbar>
        <Select
          appearance="pill"
          aria-label="Workflow template"
          onChange={(v) => update({ template: v || null })}
          options={templateOptions}
          value={templateId}
        />
        <span className="ml-1 text-xs text-paper-500">Break down by</span>
        <SegmentedControl
          ariaLabel="Break trends down by"
          onChange={(v) => update({ by: v || null })}
          options={BREAKDOWN_OPTIONS}
          value={by}
        />
      </Toolbar>

      {trendCard}

      <div className="grid gap-6 lg:grid-cols-2">
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
              <ul className="-mx-2">
                {latestRuns.data.map((r) => (
                  <li key={r.id}>
                    <Link
                      className={cn(
                        'flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md px-2 py-2.5 transition-colors hover:bg-ink-600/35',
                        FOCUS_RING
                      )}
                      href={`/govern/evals/runs/${r.id}`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-paper-100">
                          {r.datasetName ?? r.datasetSlug ?? 'Benchmark'}
                        </span>
                        <span className="block truncate font-mono text-xs text-paper-500">
                          {formatArm(r.candidateRef, r.candidateRuntime)} vs{' '}
                          {formatArm(r.baselineRef, r.baselineRuntime)}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-3">
                        <time
                          className="text-xs text-paper-500"
                          dateTime={r.startedAt}
                          title={formatDate(r.startedAt)}
                        >
                          {formatRelativeTime(r.startedAt)}
                        </time>
                        <EvalRunStatusBadge partial={r.partial} status={r.status} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                hint={
                  <>
                    Start one with{' '}
                    <code className="font-mono text-paper-300">
                      auto-swe evals run &lt;dataset&gt; --candidate=&lt;ref&gt;
                      --against=&lt;ref&gt;
                    </code>
                    .
                  </>
                }
                icon="flask"
                title="No benchmark runs yet"
              />
            )}
          </QueryBoundary>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle eyebrow="Golden cases">Datasets</CardTitle>
            {datasets && datasets.length > 0 && (
              <span className="text-xs text-paper-500 tabular-nums">
                {datasets.length} dataset{datasets.length === 1 ? '' : 's'}
              </span>
            )}
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
              <ul className="-mx-2">
                {datasets.map((d) => (
                  <li key={d.id}>
                    <Link
                      className={cn(
                        'flex items-center justify-between gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-ink-600/35',
                        FOCUS_RING
                      )}
                      href={`/govern/evals/datasets/${d.id}`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-[13px] text-paper-100">
                          {d.slug}
                        </span>
                        <Badge tone="muted" variant="outline">
                          {d.scope.charAt(0) + d.scope.slice(1).toLowerCase()}
                        </Badge>
                      </span>
                      <span className="shrink-0 text-xs text-paper-500 tabular-nums">
                        {d.caseCount} case{d.caseCount === 1 ? '' : 's'}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                hint={
                  <>
                    Datasets are created through the platform API; list and run them with{' '}
                    <code className="font-mono text-paper-300">auto-swe evals list</code> and{' '}
                    <code className="font-mono text-paper-300">auto-swe evals run</code>.
                  </>
                }
                icon="layers"
                title="No datasets yet"
              />
            )}
          </QueryBoundary>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle eyebrow="Share of golden cases quarantined as stale">Suite health</CardTitle>
          {healthQuery.data && (
            <span className="text-xs text-paper-500">
              Gate fails above {Math.round(healthQuery.data.thresholds.maxStaleRate * 100)}%
            </span>
          )}
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
          <CardTitle eyebrow="Every captured signal">Results</CardTitle>
        </CardHeader>
        <EvalResultsTable
          onScorerChange={setResultScorer}
          scorer={resultScorer}
          scorers={scorerNames}
        />
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
