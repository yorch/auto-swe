'use client';

import { use, useState } from 'react';
import { EvalResultsTable } from '@/components/evals/EvalResultsTable';
import { EvalRunStatusBadge } from '@/components/evals/EvalRunStatusBadge';
import { Alert } from '@/components/ui/Alert';
import { BackLink } from '@/components/ui/BackLink';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
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
  /** The cases the run did not score for want of a passing stability (flake) check. */
  unscreened?: Unscreened;
}

interface Unscreened {
  neverScreened: number;
  screenFailed: number;
}

/** The summary of an INCONCLUSIVE run: no case was flake-screened, so nothing was scored. */
interface Inconclusive {
  inconclusive: { awaitingScreen: number; screenFailed: number };
  summary: string;
}

function isInconclusive(v: unknown): v is Inconclusive {
  const o = v as Partial<Inconclusive> | null;
  return !!o && typeof o === 'object' && !!o.inconclusive;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The unscored cases as a sentence, or null when every case was scored. */
function unscreenedSentence(u: Unscreened | undefined): string | null {
  if (!u || u.neverScreened + u.screenFailed === 0) {
    return null;
  }
  return `Not scored: ${plural(u.neverScreened, 'case')} awaiting a stability check, ${plural(u.screenFailed, 'case')} that failed one.`;
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
  better: 'text-success-400',
  none: 'text-paper-200',
  worse: 'text-danger-400',
} as const;

function DeltaRow({ label, d }: { label: string; d: PairedDelta }) {
  return (
    <TRow>
      <Td className="px-4 py-2.5 font-medium text-paper-100" primary>
        {label}
      </Td>
      <Td align="right" className="px-4 py-2.5 text-paper-400 tabular-nums" label="Cases compared">
        {d.n}
      </Td>
      <Td align="right" className="px-4 py-2.5 text-paper-300 tabular-nums" label="Baseline">
        {pct(d.baselineRate)}
      </Td>
      <Td align="right" className="px-4 py-2.5 text-paper-300 tabular-nums" label="Candidate">
        {pct(d.candidateRate)}
      </Td>
      <Td
        align="right"
        className={`px-4 py-2.5 font-medium tabular-nums ${DELTA_TONE[significance(d)]}`}
        label="Difference"
      >
        {formatPoints(d.delta)}
      </Td>
      <Td align="right" className="px-4 py-2.5 text-paper-500 tabular-nums" label="Likely range">
        {formatPoints(d.ci95[0])} to {formatPoints(d.ci95[1])}
      </Td>
    </TRow>
  );
}

function VerdictView({ summary }: { summary: unknown }) {
  if (summary === null || summary === undefined) {
    return (
      <EmptyState
        hint="The verdict appears once every case has run on both sides."
        icon="clock"
        title="No verdict yet"
      />
    );
  }
  if (isInconclusive(summary)) {
    const { awaitingScreen, screenFailed } = summary.inconclusive;
    return (
      <Alert title="Inconclusive: no case was scored" variant="warning">
        {`None of this dataset's cases had passed a stability check yet, so there was nothing to compare. ${plural(awaitingScreen, 'case')} awaiting the check (it starts on its own), ${plural(screenFailed, 'case')} that failed it (re-check them from the dataset page). Run again once the check finishes.`}
      </Alert>
    );
  }
  if (!isVerdict(summary)) {
    // A start failure stores `{ error }`; anything else is shown as stored.
    const error = (summary as { error?: unknown }).error;
    return typeof error === 'string' ? (
      <Alert title="The run did not reach a verdict">
        <span className="font-mono text-xs">{error}</span>
      </Alert>
    ) : (
      <pre className="overflow-x-auto rounded-md border border-ink-600 bg-ink-900/60 p-3 font-mono text-xs text-paper-400">
        {JSON.stringify(summary, null, 2)}
      </pre>
    );
  }
  return (
    <div className="space-y-4">
      {summary.partial && (
        <Alert variant="warning">
          {`Partial: ${summary.partial.reason === 'org_budget' ? "the organization's monthly budget" : 'the budget'} stopped this run after ${summary.partial.completedCases} of ${summary.partial.totalCases} cases; the verdict covers only those. ${summary.partial.error}`}
        </Alert>
      )}
      <Alert variant={verdictSentence(summary.overall).tone}>
        {verdictSentence(summary.overall).text}
      </Alert>
      <p className="text-sm text-paper-400">{summary.summary}</p>
      {unscreenedSentence(summary.unscreened) && (
        <p className="text-sm text-paper-400">{unscreenedSentence(summary.unscreened)}</p>
      )}
      {summary.runtimes && (
        <p className="text-sm text-paper-400">
          {`Ran on: candidate ${describeRuntimes(summary.runtimes.candidate)}, baseline ${describeRuntimes(summary.runtimes.baseline)}`}
        </p>
      )}
      <div className="-mx-4">
        <Table className="max-sm:px-4" stacked>
          <THead>
            <Th variant="plain">Slice</Th>
            <Th align="right" variant="plain">
              <span title="Cases run on both the baseline and the candidate, so each one is compared like for like">
                Cases compared
              </span>
            </Th>
            <Th align="right" variant="plain">
              Baseline
            </Th>
            <Th align="right" variant="plain">
              Candidate
            </Th>
            <Th align="right" variant="plain">
              <span title="Candidate pass rate minus baseline pass rate, in percentage points">
                Difference
              </span>
            </Th>
            <Th align="right" variant="plain">
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
    </div>
  );
}

export default function EvalRunPage({ params }: { params: Promise<{ id: string }> }) {
  const id = validateRouteParam(use(params).id);
  const [scorer, setScorer] = useState('');
  const { data: run, error, isError, isFetching, refetch, isLoading } = useEvalRun(id);

  return (
    <div className="space-y-6">
      <BackLink
        href={run ? `/admin/evals/datasets/${run.datasetId}` : '/admin/evals'}
        label={run?.datasetName ?? 'Dataset'}
      />
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="eval run"
        onRetry={() => void refetch()}
        shape="detail"
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
                <CardTitle hint="Candidate vs baseline">Verdict</CardTitle>
              </CardHeader>
              <VerdictView summary={run.summary} />
            </Card>
            <Card>
              <CardHeader>
                <CardTitle hint="Every signal this run captured">Results</CardTitle>
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
