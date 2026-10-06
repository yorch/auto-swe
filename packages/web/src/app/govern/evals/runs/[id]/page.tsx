'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { EvalResultsTable } from '@/components/evals/EvalResultsTable';
import { EvalRunStatusBadge } from '@/components/evals/EvalRunStatusBadge';
import { Alert } from '@/components/ui/Alert';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useEvalRun } from '@/hooks/useAdmin';
import { formatArm, runtimeLabel } from '@/lib/evalRuntime';
import { formatPoints, type PairedDelta, significance, verdictSentence } from '@/lib/evalVerdict';
import { validateRouteParam } from '@/lib/routeParams';
import { formatDate } from '@/lib/utils';

interface Verdict {
  regression: boolean;
  overall: PairedDelta;
  byTag: Record<string, PairedDelta>;
  summary: string;
  /** The implementer runtimes each side actually ran on, over the cases that completed. */
  runtimes?: { baseline: string[]; candidate: string[] };
  /** Set when the runless budget stopped the run before every case ran. */
  partial?: {
    completedCases: number;
    totalCases: number;
    error: string;
    reason?: 'budget' | 'org_budget';
  };
}

function isVerdict(v: unknown): v is Verdict {
  const o = v as Partial<Verdict> | null;
  return !!o && typeof o === 'object' && typeof o.summary === 'string' && !!o.overall;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** A side's runtimes as text: one, normally; several if the setting moved mid-run. */
const describeRuntimes = (runtimes: string[]) =>
  runtimes.length > 0 ? runtimes.map((r) => runtimeLabel(r)).join(' and ') : '—';

/** A difference is coloured only when the whole likely range agrees on its direction. */
const DELTA_TONE = {
  better: 'text-moss-400',
  none: 'text-paper-200',
  worse: 'text-brick-400',
} as const;

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
        className={`px-4 py-2 font-mono text-[11px] ${DELTA_TONE[significance(d)]}`}
      >
        {formatPoints(d.delta)}
      </Td>
      <Td align="right" className="px-4 py-2 font-mono text-[11px] text-paper-500">
        {formatPoints(d.ci95[0])} to {formatPoints(d.ci95[1])}
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
      {summary.partial && (
        <p className="font-mono text-xs text-amber-400">
          {`Partial: ${summary.partial.reason === 'org_budget' ? "the organization's monthly budget" : 'the budget'} stopped this run after ${summary.partial.completedCases} of ${summary.partial.totalCases} cases; the verdict covers only those. ${summary.partial.error}`}
        </p>
      )}
      <Alert variant={verdictSentence(summary.overall).tone}>
        {verdictSentence(summary.overall).text}
      </Alert>
      <p className="font-mono text-xs text-paper-500">{summary.summary}</p>
      {summary.runtimes && (
        <p className="font-mono text-xs text-paper-400">
          {`Ran on: candidate ${describeRuntimes(summary.runtimes.candidate)}, baseline ${describeRuntimes(summary.runtimes.baseline)}`}
        </p>
      )}
      <Table>
        <THead>
          <Th variant="dense">Slice</Th>
          <Th align="right" variant="dense">
            <span title="Cases run on both the baseline and the candidate, so each one is compared like for like">
              Cases compared
            </span>
          </Th>
          <Th align="right" variant="dense">
            Baseline
          </Th>
          <Th align="right" variant="dense">
            Candidate
          </Th>
          <Th align="right" variant="dense">
            <span title="Candidate pass rate minus baseline pass rate, in percentage points">
              Difference
            </span>
          </Th>
          <Th align="right" variant="dense">
            <span title="The range the true difference very likely lies in (95% confidence). If it crosses zero, the difference may be noise.">
              Likely range
            </span>
          </Th>
        </THead>
        <tbody>
          <DeltaRow d={summary.overall} label="Overall" />
          {Object.entries(summary.byTag ?? {})
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([tag, d]) => (
              <DeltaRow d={d} key={tag} label={`Tag: ${tag}`} />
            ))}
        </tbody>
      </Table>
    </div>
  );
}

export default function EvalRunPage({ params }: { params: Promise<{ id: string }> }) {
  const id = validateRouteParam(use(params).id);
  const [scorer, setScorer] = useState('');
  const { data: run, error, isError, isFetching, refetch, isLoading } = useEvalRun(id);

  return (
    <div className="space-y-8">
      <Link
        className="label-mono hover:text-paper-200"
        href={run ? `/govern/evals/datasets/${run.datasetId}` : '/govern/evals'}
      >
        ← Dataset
      </Link>
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="eval run"
        onRetry={() => void refetch()}
      >
        {run && id && (
          <>
            <PageHeader
              actions={<EvalRunStatusBadge partial={run.partial} status={run.status} />}
              subtitle={`${formatArm(run.candidateRef, run.candidateRuntime)} vs ${formatArm(run.baselineRef, run.baselineRuntime)} · started ${formatDate(run.startedAt)}${run.endedAt ? ` · ended ${formatDate(run.endedAt)}` : ''}`}
              title={run.datasetName ? `${run.datasetName} benchmark run` : 'Benchmark run'}
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
