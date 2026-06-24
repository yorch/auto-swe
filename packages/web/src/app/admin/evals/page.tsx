'use client';

import type { EvalResultDto } from '@auto-swe/shared/types/api';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import { useEvalDatasets, useEvalResults } from '@/hooks/useAdmin';

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

function meanColor(mean: number): string {
  if (mean >= 0.9) {
    return 'var(--color-moss-400)';
  }
  if (mean >= 0.5) {
    return 'var(--color-amber-400)';
  }
  return 'var(--color-brick-400)';
}

export default function AdminEvalsPage() {
  const { data: datasets, isLoading: dsLoading } = useEvalDatasets();
  const { data: results, isLoading: rLoading } = useEvalResults({ limit: 200 });

  if (dsLoading || rLoading) {
    return <LoadingState />;
  }

  const summary = summarizeByScorer(results?.data ?? []);

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Evals</h2>

      <Card>
        <CardHeader>
          <CardTitle>Scorer trends (last {results?.meta.total ?? 0} signals)</CardTitle>
        </CardHeader>
        <div className="px-4 pb-4">
          {summary.length === 0 ? (
            <p className="text-sm text-paper-400">No eval signals captured yet.</p>
          ) : (
            <div className="space-y-1">
              {summary.map((s) => (
                <div
                  className="flex items-center justify-between gap-3 py-1.5 border-b border-ink-600/40 last:border-0"
                  key={s.scorer}
                >
                  <span className="font-mono text-xs text-paper-400">{s.scorer}</span>
                  <span className="flex items-center gap-3">
                    <span className="text-xs text-paper-600">n={s.n}</span>
                    <span className="font-mono text-xs num" style={{ color: meanColor(s.mean) }}>
                      {s.mean.toFixed(2)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Datasets ({datasets?.length ?? 0})</CardTitle>
        </CardHeader>
        <div className="px-4 pb-4">
          {datasets && datasets.length > 0 ? (
            <div className="space-y-1">
              {datasets.map((d) => (
                <div
                  className="flex items-center justify-between gap-3 py-1.5 border-b border-ink-600/40 last:border-0"
                  key={d.id}
                >
                  <span className="font-mono text-xs text-paper-300">
                    {d.slug} <span className="text-paper-600">[{d.scope}]</span>
                  </span>
                  <span className="text-xs text-paper-600">{d.caseCount} cases</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-paper-400">
              No datasets. Create one via the admin API or CLI.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
