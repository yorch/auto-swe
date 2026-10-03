'use client';

import type { EvalScorerTrend } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useState } from 'react';
import { ScorerTrendChart } from '@/components/charts/ScorerTrendChart';
import { EvalResultsTable } from '@/components/evals/EvalResultsTable';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useEvalDatasets, useEvalTrends } from '@/hooks/useAdmin';
import { cn, scoreColor } from '@/lib/utils';

const WINDOW_OPTIONS = [7, 30, 90].map((days) => ({ label: `${days}d`, value: String(days) }));

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
  // One scorer drives both the trend chart and the results filter.
  const [scorer, setScorer] = useState('');
  const trendsQuery = useEvalTrends(windowDays);
  const datasetsQuery = useEvalDatasets();
  const trends = trendsQuery.data?.scorers ?? [];
  const datasets = datasetsQuery.data;
  const charted = trends.find((t) => t.scorer === scorer) ?? trends[0];

  return (
    <div className="space-y-8">
      <PageHeader
        actions={
          <SegmentedControl
            ariaLabel="Trend window"
            onChange={(v) => setWindowDays(Number(v))}
            options={WINDOW_OPTIONS}
            value={String(windowDays)}
          />
        }
        chapter="§ Govern"
        subtitle="Per-scorer quality signals over time, every captured result with a link to the run it scored, and the datasets offline runs score against. Days are UTC."
        title="Evals"
      />

      <Card>
        <CardHeader>
          <CardTitle eyebrow={`Daily mean · last ${windowDays} days`}>
            {charted ? charted.scorer : 'Scorer trends'}
          </CardTitle>
        </CardHeader>
        <QueryBoundary
          error={trendsQuery.error}
          isError={trendsQuery.isError}
          isLoading={trendsQuery.isLoading}
          label="eval trends"
        >
          {trends.length === 0 || !charted ? (
            <EmptyState title="No eval signals in this window." />
          ) : (
            <div className="space-y-6">
              <ScorerTrendChart data={charted.daily} />
              <Table>
                <THead>
                  <Th variant="dense">Scorer</Th>
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
                    <TRow hover key={t.scorer}>
                      <Td className="px-4 py-2">
                        <button
                          aria-pressed={t.scorer === charted.scorer}
                          className={cn(
                            'font-mono text-xs hover:text-ember-400',
                            t.scorer === charted.scorer ? 'text-ember-400' : 'text-paper-300'
                          )}
                          onClick={() => setScorer(t.scorer)}
                          title="Chart this scorer and filter the results to it"
                          type="button"
                        >
                          {t.scorer}
                        </button>
                      </Td>
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
          <CardTitle>Results</CardTitle>
        </CardHeader>
        <EvalResultsTable
          onScorerChange={setScorer}
          scorer={scorer}
          scorers={trends.map((t) => t.scorer)}
        />
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
