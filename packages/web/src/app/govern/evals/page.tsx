'use client';

import type { EvalResultDto } from '@auto-swe/shared/types/api';
import type { ReactNode } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useEvalDatasets, useEvalResults } from '@/hooks/useAdmin';
import { scoreColor } from '@/lib/utils';

/** Group results by scorer → { n, passRate or mean }. The per-scorer trend the
 *  RFC §2 keeps decomposable (no blended number). */
function summarizeByScorer(results: EvalResultDto[]) {
  const by = new Map<string, { n: number; sum: number }>();
  for (const r of results) {
    const cur = by.get(r.scorer) ?? { n: 0, sum: 0 };
    cur.n += 1;
    cur.sum += r.value;
    by.set(r.scorer, cur);
  }
  return [...by.entries()]
    .map(([scorer, { n, sum }]) => ({ mean: sum / n, n, scorer }))
    .sort((a, b) => a.scorer.localeCompare(b.scorer));
}

/** One label / value line in a divided list. */
function KeyValueRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-ink-600 py-1.5 last:border-0">
      {label}
      {value}
    </div>
  );
}

export default function GovernEvalsPage() {
  const datasetsQuery = useEvalDatasets();
  const resultsQuery = useEvalResults({ limit: 200 });
  const datasets = datasetsQuery.data;
  const results = resultsQuery.data;

  const summary = summarizeByScorer(results?.data ?? []);

  return (
    <div className="space-y-8">
      <PageHeader
        chapter="§ Govern"
        subtitle="Per-scorer quality signals from recent eval runs, and the datasets they score against."
        title="Evals"
      />

      <Card>
        <CardHeader>
          <CardTitle>Scorer trends (last {results?.meta.total ?? 0} signals)</CardTitle>
        </CardHeader>
        <QueryBoundary
          error={resultsQuery.error}
          isError={resultsQuery.isError}
          isLoading={resultsQuery.isLoading}
          label="eval results"
        >
          {summary.length === 0 ? (
            <EmptyState title="No eval signals captured yet." />
          ) : (
            <div className="space-y-1">
              {summary.map((s) => (
                <KeyValueRow
                  key={s.scorer}
                  label={<span className="font-mono text-xs text-paper-400">{s.scorer}</span>}
                  value={
                    <span className="flex items-center gap-3">
                      <span className="text-xs text-paper-600">n={s.n}</span>
                      <span className="font-mono text-xs num" style={{ color: scoreColor(s.mean) }}>
                        {s.mean.toFixed(2)}
                      </span>
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </QueryBoundary>
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
                <KeyValueRow
                  key={d.id}
                  label={
                    <span className="font-mono text-xs text-paper-300">
                      {d.slug} <span className="text-paper-600">[{d.scope}]</span>
                    </span>
                  }
                  value={<span className="text-xs text-paper-600">{d.caseCount} cases</span>}
                />
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
