'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { EvalResultsTable } from '@/components/evals/EvalResultsTable';
import { EvalRunStatusBadge } from '@/components/evals/EvalRunStatusBadge';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useEvalRun } from '@/hooks/useAdmin';
import { validateRouteParam } from '@/lib/routeParams';
import { formatDate } from '@/lib/utils';

/** The harness's paired-stats verdict (`regressionVerdict` in the worker). */
interface PairedDelta {
  n: number;
  delta: number;
  baselineRate: number;
  candidateRate: number;
  se: number;
  ci95: [number, number];
}
interface Verdict {
  regression: boolean;
  overall: PairedDelta;
  byTag: Record<string, PairedDelta>;
  summary: string;
}

function isVerdict(v: unknown): v is Verdict {
  const o = v as Partial<Verdict> | null;
  return !!o && typeof o === 'object' && typeof o.summary === 'string' && !!o.overall;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pp = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pp`;

function DeltaRow({ label, d }: { label: string; d: PairedDelta }) {
  return (
    <TRow>
      <Td className="px-4 py-2 font-mono text-[11px] text-paper-300">{label}</Td>
      <Td align="right" className="px-4 py-2 font-mono text-[11px] text-paper-400">
        {d.n}
      </Td>
      <Td align="right" className="px-4 py-2 font-mono text-[11px] text-paper-400">
        {pct(d.baselineRate)}
      </Td>
      <Td align="right" className="px-4 py-2 font-mono text-[11px] text-paper-400">
        {pct(d.candidateRate)}
      </Td>
      <Td
        align="right"
        className={`px-4 py-2 font-mono text-[11px] ${d.ci95[1] < 0 ? 'text-brick-400' : 'text-paper-200'}`}
      >
        {pp(d.delta)}
      </Td>
      <Td align="right" className="px-4 py-2 font-mono text-[11px] text-paper-500">
        [{pp(d.ci95[0])}, {pp(d.ci95[1])}]
      </Td>
    </TRow>
  );
}

function VerdictView({ summary }: { summary: unknown }) {
  if (summary === null || summary === undefined) {
    return <p className="text-sm text-paper-500">No verdict yet.</p>;
  }
  if (!isVerdict(summary)) {
    // A start failure stores `{ error }`; anything else is shown as stored.
    const error = (summary as { error?: unknown }).error;
    return typeof error === 'string' ? (
      <p className="font-mono text-xs text-brick-400">{error}</p>
    ) : (
      <pre className="overflow-x-auto font-mono text-[11px] text-paper-400">
        {JSON.stringify(summary, null, 2)}
      </pre>
    );
  }
  return (
    <div className="space-y-4">
      <p
        className={`font-mono text-xs ${summary.regression ? 'text-brick-400' : 'text-paper-300'}`}
      >
        {summary.summary}
      </p>
      <Table>
        <THead>
          <Th variant="dense">Slice</Th>
          <Th align="right" variant="dense">
            Pairs
          </Th>
          <Th align="right" variant="dense">
            Baseline
          </Th>
          <Th align="right" variant="dense">
            Candidate
          </Th>
          <Th align="right" variant="dense">
            Delta
          </Th>
          <Th align="right" variant="dense">
            95% CI
          </Th>
        </THead>
        <tbody>
          <DeltaRow d={summary.overall} label="overall" />
          {Object.entries(summary.byTag ?? {})
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([tag, d]) => (
              <DeltaRow d={d} key={tag} label={`tag: ${tag}`} />
            ))}
        </tbody>
      </Table>
    </div>
  );
}

export default function EvalRunPage({ params }: { params: Promise<{ id: string }> }) {
  const id = validateRouteParam(use(params).id);
  const [scorer, setScorer] = useState('');
  const { data: run, error, isError, isLoading } = useEvalRun(id);

  return (
    <div className="space-y-8">
      <Link
        className="label-mono hover:text-paper-200"
        href={run ? `/govern/evals/datasets/${run.datasetId}` : '/govern/evals'}
      >
        ← Dataset
      </Link>
      <QueryBoundary error={error} isError={isError} isLoading={isLoading} label="eval run">
        {run && id && (
          <>
            <PageHeader
              actions={<EvalRunStatusBadge status={run.status} />}
              chapter="§ Govern · Evals · Run"
              subtitle={`${run.candidateRef} vs ${run.baselineRef} · started ${formatDate(run.startedAt)}${run.endedAt ? ` · ended ${formatDate(run.endedAt)}` : ''}`}
              title={`Eval run ${run.id.slice(0, 8)}`}
            />
            <Card>
              <CardHeader>
                <CardTitle>Verdict</CardTitle>
              </CardHeader>
              <VerdictView summary={run.summary} />
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Results</CardTitle>
              </CardHeader>
              <EvalResultsTable
                evalRunId={id}
                onScorerChange={setScorer}
                scorer={scorer}
                scorers={[]}
              />
            </Card>
          </>
        )}
      </QueryBoundary>
    </div>
  );
}
